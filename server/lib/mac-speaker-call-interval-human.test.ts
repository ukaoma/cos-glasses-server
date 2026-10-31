import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindMacSpeakerShadowRepair, type MacShadowRepairSource } from './mac-speaker-shadow-repair.js'
import { reconcileMacSpeaker256Snapshot } from './mac-speaker-live-memory.js'
import { prepareMacSpeakerCallPacket, readMacSpeakerCallView, resolveMacSpeakerCallView, type MacSpeakerCallPacket } from './mac-speaker-call-view.js'
import { applyMacCallHumanAnnotation, commitMacCallHumanAnnotation, macCallHumanScopes } from './mac-speaker-call-human.js'
import * as humanFiles from './mac-speaker-call-human.js'
import { applyMacIntervalHumanAnnotation, buildMacIntervalHumanScopes, commitMacIntervalHumanAnnotation, inspectMacIntervalHumanJournal, macIntervalHumanPaths, previewMacIntervalHumanAnnotation, recoverMacIntervalHumanAnnotation, undoMacIntervalHumanAnnotation, type MacIntervalHumanInput } from './mac-speaker-call-interval-human.js'
import { SYNTHETIC_SECONDS, SYNTHETIC_SPANS, syntheticEmbeddings, syntheticNative } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

await vi.hoisted(async () => { const { realpathSync } = await import('node:fs'); process.env.COS_DATA_DIR = realpathSync(process.env.COS_DATA_DIR!) })
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const roots: string[] = [], ledgers: string[] = []
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); ledgers.splice(0).forEach(p => rmSync(p, { force: true })) })
function fixture(edit?: (doc: any) => void, editNative?: (native: ReturnType<typeof syntheticNative>) => void, gapSeconds = 0) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'interval-human-')); roots.push(root)
  const sid = `mac_interval_${root.split('-').at(-1)}`, chunkEntries: any[] = []
  for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
    const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
    const chunk = { text: `fictional words ${raw}`, speaker: span.label, elapsed: start * 1000, audioDurationMs: seconds * 1000, audioSha256: hash(`wav${raw}`), segments: [{ speaker: span.label, startSec: 0, endSec: seconds }] }
    chunkEntries.push({ chunkIndex: raw, chunk })
  }
  let offset = 0
  const speakerWords = chunkEntries.flatMap(({ chunk }) => {
    const start = offset; offset += chunk.audioDurationMs / 1000
    return [0, 1].map(i => ({ word: `${chunk.text} token ${i}`, speaker: /^Voice /.test(chunk.speaker) ? 'Ext' : chunk.speaker, start: start + .1 + i * .2, end: start + .2 + i * .2, confidence: .87 }))
  })
  const doc: any = { sessionId: sid, sourceType: 'mac_system_audio', finalizationState: 'complete', batchApplied: true, chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, speakers: ['Dana Fictional'], batchSegments: [{ startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
  edit?.(doc)
  if (gapSeconds) for (const [i, e] of chunkEntries.entries()) if (i >= 2) { e.chunk.elapsed += gapSeconds * 1000; doc.chunks[i].elapsed += gapSeconds * 1000 }
  const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: hash(`pcm${e.chunkIndex}`), sampleCount: e.chunk.audioDurationMs * 16 }))
  const native = syntheticNative(); editNative?.(native)
  const embeddings = syntheticEmbeddings()
  if (gapSeconds) {
    native.segments = native.segments.flatMap(s => s.startTimeSeconds >= 12 ? [{ ...s, startTimeSeconds: s.startTimeSeconds + gapSeconds, endTimeSeconds: s.endTimeSeconds + gapSeconds }] : s.endTimeSeconds <= 12 ? [s] : [{ ...s, endTimeSeconds: 12 }, { ...s, startTimeSeconds: 12 + gapSeconds, endTimeSeconds: s.endTimeSeconds + gapSeconds }])
    for (let i = embeddings.length - 1; i >= 0; i--) { const e = embeddings[i]; if (e.startTime < 12 && e.endTime > 12) embeddings.splice(i, 1); else if (e.startTime >= 12) { e.startTime += gapSeconds; e.endTime += gapSeconds } }
  }
  const src: MacShadowRepairSource = { originalJSON: JSON.stringify(doc), currentJSON: JSON.stringify(doc), ledgerJSONL: '', rawAudio, timeline: { rows: rawAudio.map((r, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: r.sampleCount, usedSampleCount: r.sampleCount })), total: (SYNTHETIC_SECONDS + gapSeconds) * 16000, pcmSHA256: hash('timeline') }, cohort: { nativeJSON: JSON.stringify(native), embeddingsJSON: JSON.stringify(embeddings), modelSHA256: hash('model'), cliSHA256: hash('cli') } }
  const input = { ...src, sourceBindingSHA256: bindMacSpeakerShadowRepair(src), generation: 'synthetic-interval-human' }, state = reconcileMacSpeaker256Snapshot(null, input)
  const packet = prepareMacSpeakerCallPacket(input, state, { admission: 'qualified', projectionPolicy: 'source-bound-intervals', intervalMembership: 'native-exclusive-members' })
  const markdown = '# Fiction\n\n## Transcript\n' + speakerWords.map(w => `[${w.speaker}]: ${w.word}`).join('\n')
  const files = { sidecarPath: join(root, 'record.g2-chunks.json'), meetingPath: join(root, 'record.md') }, paths = macIntervalHumanPaths(files, sid)
  ledgers.push(paths.ledger); mkdirSync(dirname(paths.ledger), { recursive: true })
  writeFileSync(files.sidecarPath, input.currentJSON); writeFileSync(files.meetingPath, markdown); writeFileSync(paths.packet, JSON.stringify(packet))
  const args: MacIntervalHumanInput = { baseJSON: input.currentJSON, markdown, ledgerJSONL: '', legacyAnnotationJSON: null, annotationJSON: null, packet, view: resolveMacSpeakerCallView(input.currentJSON, '', packet) }
  const scopes = buildMacIntervalHumanScopes(args)
  expect(scopes.length).toBeGreaterThan(0)
  return { root, sid, doc, files, paths, args, scopes, src, input, state }
}
function commit(f: ReturnType<typeof fixture>, scope = f.scopes[0], memberIds = [scope.members[0].id], afterWrite?: (index: number) => void) {
  return commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds, to: 'Human Example', afterWrite })
}
function read(f: ReturnType<typeof fixture>, packet: MacSpeakerCallPacket | null = f.args.packet) {
  const annotationJSON = readFileSync(f.paths.annotation, 'utf8')
  const args = { ...f.args, packet, annotationJSON, view: resolveMacSpeakerCallView(f.args.baseJSON, '', packet) }
  return { args, annotation: JSON.parse(annotationJSON), view: applyMacIntervalHumanAnnotation(args) }
}
function orphanFixture() {
  const f = fixture(doc => { doc.batchSegments[0].speakerWords[0].confirmedByHuman = true })
  const statePath = f.files.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-state.json')
  writeFileSync(statePath, JSON.stringify(f.state))
  const preserved = () => [f.files.sidecarPath, f.files.meetingPath, f.paths.packet, statePath, f.paths.annotation, f.paths.journal, f.paths.ledger, f.paths.legacyAnnotation].map(path => {
    try { return { path, text: readFileSync(path, 'utf8') } } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: null }; throw error }
  })
  const owner = { kind: 'mac-speaker-call-interval-human-v1', journal: f.paths.journal, pid: 2147483000, token: 'fictional-orphan-owner' }
  return { ...f, owner, preserved, before: preserved() }
}

describe('exact HQ interval human annotations', () => {
  it('selects opaque exact word IDs, validates the passed view, and refuses caller coordinates', () => {
    const f = fixture(), s = f.scopes[0]
    expect(s.kind).toBe('interval-words'); expect(s.fieldCount).toBe(s.members.length)
    expect(s.members.every(m => /^[a-f0-9]{64}$/.test(m.id) && m.wordCount === 1)).toBe(true)
    expect(Object.isFrozen(s.members)).toBe(true)
    expect(previewMacIntervalHumanAnnotation(s, [s.members[0].id], 'Human Example').fields).toBe(1)
    expect(() => previewMacIntervalHumanAnnotation(s, [f.scopes[1].members[0].id], 'Human Example')).toThrow('outside reviewed')
    for (const ids of [[s.members[0].id, s.members[0].id], ['batchSegments/0/speakerWords/0'], [], [hash('unknown')]]) expect(() => previewMacIntervalHumanAnnotation(s, ids, 'Human Example')).toThrow()
    expect(() => previewMacIntervalHumanAnnotation(s, [s.members[0].id], 'Voice 1')).toThrow('explicit name')
    const forged = structuredClone(f.args.view); forged.doc.batchSegments[0].speakerWords[0].speaker = 'Anonymous group 2'
    expect(() => buildMacIntervalHumanScopes({ ...f.args, view: forged })).toThrow('unvalidated reviewed view')
  })
  it('writes only its bounded sidecars and names one exact HQ word without modifying roots, nested rows, proofs, or source bytes', () => {
    const f = fixture(), before = structuredClone(f.args.view.doc), result = commit(f), { annotation, view } = read(f)
    expect(result.fields).toBe(1); expect(result.members).toBe(1)
    const m = annotation.events[0].members[0]
    before.batchSegments[m.batchIndex].speakerWords[m.wordIndex].speaker = 'Human Example'
    expect(view.doc).toEqual(before)
    expect(view.metadata.intervalHumanAnnotation).toMatchObject({ revision: 1, activeActions: [{ actionId: result.correctionId, to: 'Human Example', memberIds: [f.scopes[0].members[0].id] }], confirmedWords: [{ batchIndex: m.batchIndex, wordIndex: m.wordIndex, label: 'Human Example', wordSHA256: m.wordSHA256 }] })
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.args.markdown)
    expect(() => readFileSync(f.paths.ledger)).toThrow(); expect(() => readFileSync(f.paths.legacyAnnotation)).toThrow()
    expect(JSON.parse(readFileSync(f.paths.journal, 'utf8')).phase).toBe('complete')
  })
  it('keeps two identities inside the same raw chunk separate and excludes a word crossing their boundary', () => {
    const f = fixture(doc => {
      doc.batchSegments[0].speakerWords[1].start = 4.1; doc.batchSegments[0].speakerWords[1].end = 4.2
      doc.batchSegments[0].speakerWords.push({ word: 'crosses identity boundary', start: 3.9, end: 4.1, speaker: 'Ext' })
    }, native => {
      native.segments[0].endTimeSeconds = 4
      native.segments.push({ speakerId: 'S2', startTimeSeconds: 4, endTimeSeconds: 6, qualityScore: 1 }, { speakerId: 'S1', startTimeSeconds: 6, endTimeSeconds: 40, qualityScore: 1 })
    })
    const one = f.scopes.find(s => s.members.some(m => m.text === 'fictional words 0 token 0'))!, two = f.scopes.find(s => s.members.some(m => m.text === 'fictional words 0 token 1'))!
    expect(one.identityId).not.toBe(two.identityId)
    expect(f.scopes.filter(s => s.kind === 'interval-words').flatMap(s => s.members.map(m => m.text))).not.toContain('crosses identity boundary')
    expect(f.scopes.find(s => s.kind === 'unresolved-words')!.members.map(m => m.text)).toContain('crosses identity boundary')
    commit(f, one, [one.members.find(m => m.text === 'fictional words 0 token 0')!.id])
    const out = read(f)
    expect(out.view.doc.batchSegments[0].speakerWords[0].speaker).toBe('Human Example')
    expect(out.view.doc.batchSegments[0].speakerWords[1].speaker).toBe(two.displayLabel)
    expect(out.view.doc.chunkEntries[0]).toEqual(f.args.view.doc.chunkEntries[0])
  })
  it('recomputes each successive selection with producers disabled and keeps packet and shared ledger unchanged', () => {
    const f = fixture(), packetBefore = readFileSync(f.paths.packet, 'utf8'); commit(f)
    const first = read(f), scopes = buildMacIntervalHumanScopes({ ...first.args, view: first.view })
    expect(scopes[0].members.some(m => m.id === f.scopes[0].members[0].id)).toBe(false)
    const second = commit(f, scopes[0]), out = read(f)
    expect(second.revision).toBe(2); expect(out.annotation.packets).toHaveLength(1)
    expect(out.view.metadata.intervalHumanAnnotation?.confirmedWords).toHaveLength(2)
    expect(readFileSync(f.paths.packet, 'utf8')).toBe(packetBefore); expect(() => readFileSync(f.paths.ledger)).toThrow()
    expect(() => commit(f)).toThrow('reviewed source changed')
  })
  it('rejects existing BASE speaker names at preview, commit, and rehashed annotation validation, including protected HQ rows', () => {
    const f = fixture(doc => { doc.batchSegments[0].speakerWords[0].speaker = 'Protected Person'; doc.batchSegments[0].speakerWords[0].confirmedByHuman = true })
    const scope = f.scopes[0], ids = [scope.members[0].id]
    for (const to of ['Dana Fictional', 'Protected Person', 'protected person']) {
      expect(scope.forbiddenNames.some(n => n.toLowerCase() === to.toLowerCase())).toBe(true)
      expect(() => previewMacIntervalHumanAnnotation(scope, ids, to)).toThrow('already exists in source')
      expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: ids, to })).toThrow('already exists in source')
    }
    expect(() => readFileSync(f.paths.journal)).toThrow()
    commit(f); const current = read(f), annotation = structuredClone(current.annotation)
    annotation.events[0].to = 'Protected Person'
    const { annotationSHA256: _, ...body } = annotation; annotation.annotationSHA256 = hash(JSON.stringify(body))
    expect(() => applyMacIntervalHumanAnnotation({ ...current.args, annotationJSON: JSON.stringify(annotation) })).toThrow('already exists in source')
  })
  it('rejects a name existing only in the validated legacy annotation without blocking a fresh exact-word name', () => {
    const f = fixture(), v1 = prepareMacSpeakerCallPacket(f.input, f.state, { admission: 'qualified', projectionPolicy: 'anonymous-estimate' })
    writeFileSync(f.paths.packet, JSON.stringify(v1))
    const legacyScope = macCallHumanScopes({ baseJSON: f.args.baseJSON, markdown: f.args.markdown, ledgerJSONL: '', annotationJSON: null, packet: v1, view: resolveMacSpeakerCallView(f.args.baseJSON, '', v1) })[0]
    commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope: legacyScope, selectedRawChunkIndices: [legacyScope.members[0].rawChunkIndex], to: 'Legacy Person' })
    const ledgerJSONL = readFileSync(f.paths.ledger, 'utf8'), legacyAnnotationJSON = readFileSync(f.paths.legacyAnnotation, 'utf8'), src = { ...f.src, ledgerJSONL }
    const input = { ...src, sourceBindingSHA256: bindMacSpeakerShadowRepair(src), generation: 'after-legacy' }, state = reconcileMacSpeaker256Snapshot(null, input)
    const packet = prepareMacSpeakerCallPacket(input, state, { admission: 'qualified', projectionPolicy: 'source-bound-intervals', intervalMembership: 'native-exclusive-members' })
    writeFileSync(f.paths.packet, JSON.stringify(packet))
    const view = applyMacCallHumanAnnotation(f.args.baseJSON, ledgerJSONL, legacyAnnotationJSON, resolveMacSpeakerCallView(f.args.baseJSON, ledgerJSONL, packet))
    const scopes = buildMacIntervalHumanScopes({ ...f.args, ledgerJSONL, legacyAnnotationJSON, packet, view }), scope = scopes[0], memberIds = [scope.members[0].id]
    expect(scope.forbiddenNames).toContain('Legacy Person')
    expect(() => previewMacIntervalHumanAnnotation(scope, memberIds, 'Legacy Person')).toThrow('already exists in source')
    expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds, to: 'Legacy Person' })).toThrow('already exists in source')
    expect(commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds, to: 'Fresh Person' }).members).toBe(1)
    expect(readFileSync(f.paths.ledger, 'utf8')).toBe(ledgerJSONL); expect(readFileSync(f.paths.legacyAnnotation, 'utf8')).toBe(legacyAnnotationJSON)
  })
  it('excludes only words whose capture-piece clock disagrees with the reviewer after a raw gap', () => {
    const f = fixture(undefined, undefined, 60), members = f.scopes.filter(s => s.kind === 'interval-words').flatMap(s => s.members), laterWord = f.doc.batchSegments[0].speakerWords[4]
    expect(f.args.view.doc.batchSegments[0].speakerWords[4].speaker).toMatch(/^Anonymous group /)
    expect(members.some(m => m.text === laterWord.word)).toBe(false)
    expect(members.some(m => m.text === 'fictional words 0 token 0')).toBe(true)
    expect(members.every(m => m.endElapsedMs <= 12000)).toBe(true)
    commit(f)
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON)
    const withinSample = fixture(doc => { doc.batchSegments[0].startElapsed = 1 / 32 })
    expect(withinSample.scopes.flatMap(s => s.members).some(m => m.text === 'fictional words 0 token 0')).toBe(true)
  })
  it('checks the exact audit predecessor hash after a disjoint second name', () => {
    const f = fixture(); commit(f)
    const first = read(f), scopes = buildMacIntervalHumanScopes({ ...first.args, view: first.view }); commit(f, scopes[1])
    const current = read(f), annotation = structuredClone(current.annotation)
    annotation.events[1].priorAnnotationSHA256 = hash('unrelated predecessor')
    const { annotationSHA256: _, ...body } = annotation; annotation.annotationSHA256 = hash(JSON.stringify(body))
    expect(() => applyMacIntervalHumanAnnotation({ ...current.args, annotationJSON: JSON.stringify(annotation) })).toThrow('audit chain predecessor')
  })
  it('names one contiguous unresolved HQ range with stored timing and no acoustic identity claim', () => {
    const f = fixture(), raw = f.doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 9'), scope = f.scopes.find(s => s.kind === 'unresolved-words')!
    const members = [0, 1].map(i => scope.members.find(m => m.text === `fictional words ${raw} token ${i}`)!)
    expect(members.every(Boolean)).toBe(true)
    expect(scope).toMatchObject({ identityId: 'unresolved', displayLabel: 'Unresolved speech' })
    expect(scope.selectionRuns!.flat()).toEqual(scope.members.map(m => m.id))
    expect(new Set(scope.selectionRuns!.flat()).size).toBe(scope.members.length)
    expect(members[0].startElapsedMs).toBe(203100)
    const selected = members.map(m => m.id), preview = previewMacIntervalHumanAnnotation(scope, selected.slice().reverse(), 'Manual Person')
    expect(preview.members).toEqual(members)
    const before = structuredClone(f.args.view.doc)
    const result = commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: selected, to: 'Manual Person' }), out = read(f)
    expect(out.annotation.events[0]).toMatchObject({ reviewKind: 'unresolved-words', identityId: 'unresolved', projectionPacketSHA256: f.args.packet!.packetSHA256 })
    expect(out.view.metadata.intervalHumanAnnotation!.activeActions[0]).toMatchObject({ actionId: result.correctionId, identityId: `action-${result.correctionId.split(':').at(-1)}` })
    for (const m of out.annotation.events[0].members) before.batchSegments[m.batchIndex].speakerWords[m.wordIndex].speaker = 'Manual Person'
    expect(out.view.doc).toEqual(before)
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.args.markdown)
    expect(() => readFileSync(f.paths.ledger)).toThrow()
    const current = buildMacIntervalHumanScopes({ ...out.args, view: out.view }).find(s => s.kind === 'unresolved-words')!
    expect(current.members.some(m => selected.includes(m.id))).toBe(false)
    expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: selected, to: 'Another Person' })).toThrow('reviewed source changed')
  })
  it('refuses unresolved selections across protected, nonconsecutive, previously human, and cross-batch words', () => {
    const f = fixture(doc => {
      const raw = doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 9'), at = (raw + 1) * 2
      doc.batchSegments[0].speakerWords.splice(at + 1, 0, { word: 'protected gap', start: 209.22, end: 209.25, speaker: 'Ext', confirmedByHuman: true })
      doc.batchSegments.push({ startChunkIdx: 0, endChunkIdx: doc.chunkEntries.length - 1, startElapsed: 0, speakerWords: [{ word: 'other batch unresolved', start: 203.1, end: 203.2, speaker: 'Ext' }] })
    }), scope = f.scopes.find(s => s.kind === 'unresolved-words')!, raw = f.doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 9')
    const first = scope.members.find(m => m.text === `fictional words ${raw} token 0`)!, afterGap = scope.members.find(m => m.text === `fictional words ${raw + 2} token 0`)!, otherBatch = scope.members.find(m => m.text === 'other batch unresolved')!
    expect(scope.members.some(m => m.text === 'protected gap')).toBe(false)
    for (const selected of [[first.id, afterGap.id], [first.id, otherBatch.id], [scope.members[0].id, scope.members.at(-1)!.id]]) {
      expect(() => previewMacIntervalHumanAnnotation(scope, selected, 'Manual Person')).toThrow('contiguous range')
      expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: selected, to: 'Manual Person' })).toThrow('contiguous range')
    }
    commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: [first.id], to: 'Manual Person' })
    const named = read(f), refreshed = buildMacIntervalHumanScopes({ ...named.args, view: named.view }).find(s => s.kind === 'unresolved-words')!
    expect(() => previewMacIntervalHumanAnnotation(refreshed, [first.id], 'Other Person')).toThrow('outside reviewed group')
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON)
  })
  it('uses an audited qualified packet for manual unresolved naming after automatic withdrawal', () => {
    const f = fixture(); commit(f); unlinkSync(f.paths.packet)
    const before = read(f, null), scope = buildMacIntervalHumanScopes({ ...before.args, view: before.view }).find(s => s.kind === 'unresolved-words')!
    expect(scope.projectionPacketSHA256).toBeNull()
    const member = scope.members[0], result = commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: [member.id], to: 'Manual Person' }), out = read(f, null)
    expect(out.annotation.packets).toHaveLength(1)
    expect(out.annotation.events.at(-1)).toMatchObject({ identityId: 'unresolved', reviewKind: 'unresolved-words', projectionPacketSHA256: null })
    expect(out.view.metadata.intervalHumanAnnotation!.activeActions.some(a => a.actionId === result.correctionId)).toBe(true)
    const noProof = fixture(); unlinkSync(noProof.paths.packet)
    const baseView = resolveMacSpeakerCallView(noProof.args.baseJSON, '', null)
    expect(buildMacIntervalHumanScopes({ ...noProof.args, packet: null, view: baseView })).toEqual([])
  })
  it('renames a whole active exact action after missing/corrupt packets and unwinds supersessions in order', () => {
    const f = fixture(), original = commit(f, f.scopes[0], f.scopes[0].members.slice(0, 2).map(m => m.id))
    unlinkSync(f.paths.packet)
    const named = read(f, null), scope = buildMacIntervalHumanScopes({ ...named.args, view: named.view }).find(s => s.kind === 'human-words')!
    expect(scope.identityId).toBe(named.view.metadata.intervalHumanAnnotation!.activeActions[0].identityId)
    expect(scope.displayLabel).toBe('Human Example')
    expect(() => previewMacIntervalHumanAnnotation(scope, [scope.members[0].id], 'Correct Person')).toThrow('whole active action')
    expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: scope.members.map(m => m.id), to: 'Dana Fictional' })).toThrow('already exists in source')
    const second = commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: scope.members.map(m => m.id).reverse(), to: 'Correct Person' })
    let out = read(f, null)
    expect(out.annotation.events[1]).toMatchObject({ reviewKind: 'human-words', supersedesActionId: original.correctionId, to: 'Correct Person' })
    expect(out.annotation.events[0].to).toBe('Human Example')
    expect(out.annotation.events[1].members).toEqual(out.annotation.events[0].members)
    expect(out.view.metadata.intervalHumanAnnotation!.activeActions).toHaveLength(1)
    expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: scope.members.map(m => m.id), to: 'Stale Person' })).toThrow('reviewed source changed')
    const undo = (id: string) => { const current = read(f, null); return undoMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, actionId: id, revision: current.annotation.revision, annotationSHA256: current.annotation.annotationSHA256 }) }
    expect(() => undo(original.correctionId)).toThrow('active superseding edit')
    writeFileSync(f.paths.packet, '{corrupt automatic packet')
    const nextScope = buildMacIntervalHumanScopes({ ...out.args, view: out.view }).find(s => s.kind === 'human-words')!
    const third = commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope: nextScope, memberIds: nextScope.members.map(m => m.id), to: 'Final Person' })
    expect(() => undo(second.correctionId)).toThrow('active superseding edit')
    undo(third.correctionId); out = read(f, null)
    expect(out.view.metadata.intervalHumanAnnotation!.activeActions[0]).toMatchObject({ actionId: second.correctionId, to: 'Correct Person' })
    undo(second.correctionId); out = read(f, null)
    expect(out.view.metadata.intervalHumanAnnotation!.activeActions[0]).toMatchObject({ actionId: original.correctionId, to: 'Human Example' })
    undo(original.correctionId); out = read(f, null)
    expect(out.view.metadata.intervalHumanAnnotation!.activeActions).toEqual([])
    expect(undo(third.correctionId).undone).toBe(false)
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.args.markdown)
    expect(() => readFileSync(f.paths.ledger)).toThrow()
  })
  it('recovers an interrupted atomic rename without publishing duplicate actions or touching source documents', () => {
    const f = fixture(); commit(f)
    const named = read(f), scope = buildMacIntervalHumanScopes({ ...named.args, view: named.view }).find(s => s.kind === 'human-words')!
    expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope, memberIds: scope.members.map(m => m.id), to: 'Renamed Person', afterWrite: () => { throw new Error('rename interrupted') } })).toThrow('rename interrupted')
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('prepared')
    const bytes = readFileSync(f.paths.annotation, 'utf8')
    recoverMacIntervalHumanAnnotation(f.files, f.sid)
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(bytes)
    const out = read(f)
    expect(out.annotation.events).toHaveLength(2); expect(out.view.metadata.intervalHumanAnnotation!.activeActions).toHaveLength(1)
    expect(out.view.metadata.intervalHumanAnnotation!.activeActions[0].to).toBe('Renamed Person')
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON)
  })
  it.each(['base', 'markdown', 'ledger', 'legacy', 'packet'] as const)('refuses stale %s CAS before creating an annotation', key => {
    const f = fixture()
    const paths = { base: f.files.sidecarPath, markdown: f.files.meetingPath, ledger: f.paths.ledger, legacy: f.paths.legacyAnnotation, packet: f.paths.packet }
    const text = key === 'base' ? f.args.baseJSON + '\n' : key === 'markdown' ? f.args.markdown + '\n' : key === 'ledger' ? '{"source":"human"}\n' : key === 'legacy' ? '{}' : '{}'
    writeFileSync(paths[key], text)
    expect(() => commit(f)).toThrow(); expect(() => readFileSync(f.paths.annotation)).toThrow(); expect(() => readFileSync(f.paths.journal)).toThrow()
  })
  it('retains exact human source-bound words after packet removal, off admission, and changed current group labels', () => {
    const f = fixture(), result = commit(f), withPacket = read(f)
    unlinkSync(f.paths.packet)
    const withdrawn = read(f, null)
    expect(withdrawn.view.metadata.intervalHumanAnnotation?.activeActions[0].actionId).toBe(result.correctionId)
    expect(withdrawn.view.metadata.intervalHumanAnnotation?.confirmedWords).toEqual(withPacket.view.metadata.intervalHumanAnnotation?.confirmedWords)
    const scopes = buildMacIntervalHumanScopes({ ...withdrawn.args, view: withdrawn.view })
    expect(scopes.some(s => s.kind === 'interval-words')).toBe(false)
    expect(scopes.some(s => s.kind === 'human-words')).toBe(true)
    const off = structuredClone(f.args.packet!); off.admission = 'off'; const { packetSHA256: _, ...body } = off; off.packetSHA256 = hash(JSON.stringify(body))
    expect(read(f, off).view.metadata.intervalHumanAnnotation?.confirmedWords).toHaveLength(1)
  })
  it('allows exact undo after a disjoint later name, preserves its audit, and repeats undo idempotently', () => {
    const f = fixture(), first = commit(f), current = read(f), scopes = buildMacIntervalHumanScopes({ ...current.args, view: current.view })
    const second = commit(f, scopes[1]), named = read(f)
    const undone = undoMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, actionId: first.correctionId, revision: named.annotation.revision, annotationSHA256: named.annotation.annotationSHA256 })
    expect(undone).toMatchObject({ undone: true, revision: 3 })
    const after = read(f)
    expect(after.annotation.events).toHaveLength(3); expect(after.annotation.events.slice(0, 2)).toEqual(named.annotation.events)
    expect(after.view.metadata.intervalHumanAnnotation?.activeActions).toMatchObject([{ actionId: second.correctionId }])
    expect(undoMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, actionId: first.correctionId, revision: 1, annotationSHA256: hash('stale') }).undone).toBe(false)
    expect(() => undoMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, actionId: second.correctionId, revision: 1, annotationSHA256: hash('stale') })).toThrow('reviewed annotation changed')
  })
  it('refuses a rehashed overlapping action and changed/protected audited words', () => {
    const f = fixture(); commit(f); const current = read(f), a = structuredClone(current.annotation)
    const repeated = { ...a.events[0], id: a.events[0].id + '-second', priorAnnotationSHA256: a.annotationSHA256 }
    a.events.push(repeated); a.revision++
    const { annotationSHA256: _, ...body } = a; a.annotationSHA256 = hash(JSON.stringify(body))
    expect(() => applyMacIntervalHumanAnnotation({ ...current.args, annotationJSON: JSON.stringify(a) })).toThrow('overlapping active')
    const badView = structuredClone(current.args.view); const m = current.annotation.events[0].members[0]
    badView.doc.batchSegments[m.batchIndex].speakerWords[m.wordIndex].confirmedByHuman = true
    expect(() => applyMacIntervalHumanAnnotation({ ...current.args, view: badView })).toThrow('conflicts with human')
    expect(() => applyMacIntervalHumanAnnotation({ ...current.args, annotationJSON: current.args.annotationJSON!.replace('Human Example', 'Other Person') })).toThrow('integrity')
  })
  it('recovers an interrupted single sidecar replacement exactly once and refuses later human edits', () => {
    const f = fixture()
    expect(() => commit(f, f.scopes[0], [f.scopes[0].members[0].id], () => { throw new Error('synthetic interruption') })).toThrow('synthetic interruption')
    const annotation = readFileSync(f.paths.annotation, 'utf8')
    expect(JSON.parse(readFileSync(f.paths.journal, 'utf8')).phase).toBe('prepared')
    recoverMacIntervalHumanAnnotation(f.files, f.sid)
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(annotation)
    expect(JSON.parse(readFileSync(f.paths.journal, 'utf8')).phase).toBe('complete')
    recoverMacIntervalHumanAnnotation(f.files, f.sid)
    writeFileSync(f.paths.annotation, annotation + '\n')
    expect(() => recoverMacIntervalHumanAnnotation(f.files, f.sid)).toThrow('later human edit')
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON)
  })
  it('undoes and recovers with malformed current automatic JSON while pinning its raw bytes and preserving strict human validation', () => {
    const f = fixture(), result = commit(f), named = read(f), malformed = '{malformed current automatic packet'
    writeFileSync(f.paths.packet, malformed)
    const undo = { files: f.files, captureId: f.sid, actionId: result.correctionId, revision: named.annotation.revision, annotationSHA256: named.annotation.annotationSHA256 }
    expect(() => undoMacIntervalHumanAnnotation({ ...undo, afterWrite: () => { throw new Error('undo interrupted') } })).toThrow('undo interrupted')
    const after = readFileSync(f.paths.annotation, 'utf8')
    writeFileSync(f.paths.packet, malformed + 'changed')
    expect(() => recoverMacIntervalHumanAnnotation(f.files, f.sid)).toThrow('source changed')
    writeFileSync(f.paths.packet, malformed)
    recoverMacIntervalHumanAnnotation(f.files, f.sid)
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(after)
    expect(read(f, null).view.metadata.intervalHumanAnnotation?.activeActions).toEqual([])
    expect(readFileSync(f.paths.packet, 'utf8')).toBe(malformed)
    writeFileSync(f.paths.annotation, '{invalid human annotation')
    expect(() => undoMacIntervalHumanAnnotation(undo)).toThrow()
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe('{invalid human annotation')
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON)
  })
  it('reports absent and malformed complete receipts without creating a lock or changing source files', () => {
    const f = fixture()
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'absent' })
    expect(() => readFileSync(f.paths.journal)).toThrow(); expect(() => readFileSync(f.paths.lock)).toThrow()
    for (const text of ['{"phase":"complete"}', '{bad journal', 'null']) {
      writeFileSync(f.paths.journal, text)
      expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
      expect(readFileSync(f.paths.journal, 'utf8')).toBe(text)
    }
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.args.baseJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.args.markdown)
    expect(() => readFileSync(f.paths.annotation)).toThrow(); expect(() => readFileSync(f.paths.lock)).toThrow()
  })
  it('exposes a first-action orphan to readers and explicitly recovers only its proven dead lock', () => {
    const f = orphanFixture(), lock = JSON.stringify(f.owner)
    writeFileSync(f.paths.lock, lock)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
    expect(readMacSpeakerCallView(f.files.sidecarPath, f.args.baseJSON, f.files.meetingPath).metadata.intervalHumanRecoveryRequired).toBe(true)
    expect(readFileSync(f.paths.lock, 'utf8')).toBe(lock); expect(f.preserved()).toEqual(f.before)
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('fictional dead owner'), { code: 'ESRCH' }) })
    try {
      recoverMacIntervalHumanAnnotation(f.files, f.sid)
      expect(probe.mock.calls).toEqual([[f.owner.pid, 0]])
    } finally { probe.mockRestore() }
    expect(() => readFileSync(f.paths.lock)).toThrow(); expect(f.preserved()).toEqual(f.before)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'absent' })
    expect(readMacSpeakerCallView(f.files.sidecarPath, f.args.baseJSON, f.files.meetingPath).metadata.intervalHumanRecoveryRequired).toBeUndefined()
    expect(commit(f).revision).toBe(1)
  })
  it.each(['live', 'EPERM', 'unknown'] as const)('leaves a no-journal owned lock untouched when its owner is %s', outcome => {
    const f = orphanFixture(), lock = JSON.stringify(f.owner)
    writeFileSync(f.paths.lock, lock)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (outcome === 'live') return true
      if (outcome === 'EPERM') throw Object.assign(Error('fictional unknown owner status'), { code: 'EPERM' })
      throw Error('fictional process identity unavailable')
    })
    try {
      expect(() => recoverMacIntervalHumanAnnotation(f.files, f.sid)).toThrow()
      expect(probe.mock.calls).toEqual([[f.owner.pid, 0]])
    } finally { probe.mockRestore() }
    expect(readFileSync(f.paths.lock, 'utf8')).toBe(lock); expect(f.preserved()).toEqual(f.before)
  })
  it.each(['foreign-kind', 'foreign-journal', 'invalid-pid', 'malformed'] as const)('refuses a no-journal %s lock without probing or altering it', kind => {
    const f = orphanFixture(), lock = kind === 'malformed' ? '{fictional unreadable owner' : JSON.stringify({ ...f.owner,
      ...(kind === 'foreign-kind' ? { kind: 'another-operation' } : {}),
      ...(kind === 'foreign-journal' ? { journal: f.paths.journal + '.different' } : {}),
      ...(kind === 'invalid-pid' ? { pid: 0 } : {}),
    })
    writeFileSync(f.paths.lock, lock)
    const probe = vi.spyOn(process, 'kill')
    try { expect(() => recoverMacIntervalHumanAnnotation(f.files, f.sid)).toThrow(); expect(probe).not.toHaveBeenCalled() } finally { probe.mockRestore() }
    expect(readFileSync(f.paths.lock, 'utf8')).toBe(lock); expect(f.preserved()).toEqual(f.before)
  })
  it('refuses to consume a journal arriving after orphan inspection and preserves its exact bytes', () => {
    const f = orphanFixture(), lock = JSON.stringify(f.owner), laterJournal = '{fictional later recovery receipt'
    writeFileSync(f.paths.lock, lock)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      writeFileSync(f.paths.journal, laterJournal)
      throw Object.assign(Error('fictional dead owner'), { code: 'ESRCH' })
    })
    try { expect(() => recoverMacIntervalHumanAnnotation(f.files, f.sid)).toThrow('journal appeared'); expect(probe.mock.calls).toEqual([[f.owner.pid, 0]]) } finally { probe.mockRestore() }
    expect(readFileSync(f.paths.journal, 'utf8')).toBe(laterJournal)
    expect(() => readFileSync(f.paths.lock)).toThrow()
    expect(f.preserved().filter(p => p.path !== f.paths.journal)).toEqual(f.before.filter(p => p.path !== f.paths.journal))
  })
  it('leaves a replacement lock untouched when ownership changes during the dead-owner probe', () => {
    const f = orphanFixture(), lock = JSON.stringify(f.owner), replacement = JSON.stringify({ ...f.owner, token: 'fictional-later-owner' })
    writeFileSync(f.paths.lock, lock)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      writeFileSync(f.paths.lock, replacement)
      throw Object.assign(Error('fictional dead owner'), { code: 'ESRCH' })
    })
    try { expect(() => recoverMacIntervalHumanAnnotation(f.files, f.sid)).toThrow('lock drift'); expect(probe.mock.calls).toEqual([[f.owner.pid, 0]]) } finally { probe.mockRestore() }
    expect(readFileSync(f.paths.lock, 'utf8')).toBe(replacement); expect(f.preserved()).toEqual(f.before)
  })
  it('pins the initially observed orphan lock before acquisition and refuses a replacement without probing it', () => {
    const f = orphanFixture(), lock = JSON.stringify(f.owner), replacement = JSON.stringify({ ...f.owner, token: 'fictional-replaced-before-acquire' })
    writeFileSync(f.paths.lock, lock)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
    const originalRead = humanFiles.readMacCallHumanFile
    let firstLockRead = true
    const reads = vi.spyOn(humanFiles, 'readMacCallHumanFile').mockImplementation((path, maximum, optional) => {
      const result = originalRead(path, maximum, optional)
      if (path === f.paths.lock && firstLockRead) { firstLockRead = false; writeFileSync(path, replacement) }
      return result
    })
    const probe = vi.spyOn(process, 'kill')
    try { expect(() => recoverMacIntervalHumanAnnotation(f.files, f.sid)).toThrow('lock drift'); expect(probe).not.toHaveBeenCalled() } finally { reads.mockRestore(); probe.mockRestore() }
    expect(readFileSync(f.paths.lock, 'utf8')).toBe(replacement); expect(f.preserved()).toEqual(f.before)
  })
  it('verifies completed human postimages and immutable pins while allowing current automatic packet withdrawal or corruption', () => {
    const f = fixture(); commit(f)
    const annotation = readFileSync(f.paths.annotation, 'utf8'), journal = readFileSync(f.paths.journal, 'utf8')
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'complete' })
    unlinkSync(f.paths.packet)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'complete' })
    writeFileSync(f.paths.packet, '{invalid automatic packet')
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'complete' })
    writeFileSync(f.files.meetingPath, f.args.markdown + '\n')
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
    writeFileSync(f.files.meetingPath, f.args.markdown)
    writeFileSync(f.paths.annotation, annotation + '\n')
    expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(annotation + '\n')
    expect(readFileSync(f.paths.journal, 'utf8')).toBe(journal)
  })
  it('rejects rehashed receipt policy, path, source pin, postimage, and human annotation corruption', () => {
    const f = fixture(); commit(f)
    const journal = JSON.parse(readFileSync(f.paths.journal, 'utf8')), annotation = readFileSync(f.paths.annotation, 'utf8')
    const edits = [
      (j: any) => { j.policy = 'other-policy' },
      (j: any) => { j.pins[0].path = f.paths.packet },
      (j: any) => { j.pins[0].hash = hash('wrong source') },
      (j: any) => { j.after += '\n' },
      (j: any) => { j.after = annotation.replace('Human Example', 'Wrong Person'); writeFileSync(f.paths.annotation, j.after) },
    ]
    for (const edit of edits) {
      writeFileSync(f.paths.annotation, annotation)
      const changed = structuredClone(journal); edit(changed)
      const { journalSHA256: _, ...body } = changed; changed.journalSHA256 = hash(JSON.stringify(body))
      const text = JSON.stringify(changed); writeFileSync(f.paths.journal, text)
      expect(inspectMacIntervalHumanJournal(f.files, f.sid).status).toBe('recovery-invalid')
      expect(readFileSync(f.paths.journal, 'utf8')).toBe(text)
    }
  })
  it('reports prepared receipts read-only for both atomic sides and requires recovery after interrupted undo before idempotent retry', () => {
    const f = fixture()
    expect(() => commit(f, f.scopes[0], [f.scopes[0].members[0].id], () => { throw new Error('name interrupted') })).toThrow('name interrupted')
    const postimage = readFileSync(f.paths.annotation, 'utf8'), prepared = readFileSync(f.paths.journal, 'utf8')
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'prepared' })
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(postimage); expect(readFileSync(f.paths.journal, 'utf8')).toBe(prepared)
    unlinkSync(f.paths.annotation)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'prepared' })
    expect(() => readFileSync(f.paths.annotation)).toThrow(); expect(() => readFileSync(f.paths.lock)).toThrow()
    recoverMacIntervalHumanAnnotation(f.files, f.sid)
    const named = read(f), actionId = named.annotation.events[0].id
    const undo = { files: f.files, captureId: f.sid, actionId, revision: named.annotation.revision, annotationSHA256: named.annotation.annotationSHA256 }
    expect(() => undoMacIntervalHumanAnnotation({ ...undo, afterWrite: () => { throw new Error('undo interrupted') } })).toThrow('undo interrupted')
    const interrupted = readFileSync(f.paths.annotation, 'utf8')
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'prepared' })
    expect(() => undoMacIntervalHumanAnnotation(undo)).toThrow('annotation recovery required')
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(interrupted)
    recoverMacIntervalHumanAnnotation(f.files, f.sid)
    expect(inspectMacIntervalHumanJournal(f.files, f.sid)).toEqual({ status: 'complete' })
    expect(undoMacIntervalHumanAnnotation(undo).undone).toBe(false)
  })
  it('refuses symlink publication targets and capture locks without touching their referents', () => {
    const f = fixture(), target = join(f.root, 'untouched.json'); writeFileSync(target, '{}')
    symlinkSync(target, f.paths.annotation)
    expect(() => commit(f)).toThrow(); expect(readFileSync(target, 'utf8')).toBe('{}')
    unlinkSync(f.paths.annotation); symlinkSync(target, f.paths.lock)
    expect(() => commit(f)).toThrow(); expect(readFileSync(target, 'utf8')).toBe('{}')
  })
  it('omits source-protected, named, unsupported, crossing-identity, and partially covered HQ words', () => {
    const f = fixture(doc => {
      doc.batchSegments[0].speakerWords[0].manuallyCorrected = true
      doc.batchSegments[0].speakerWords[1].speaker = 'Existing Human'
      doc.batchSegments[0].speakerWords.push({ word: 'different identities crossing', speaker: 'Ext', start: 61.9, end: 62.1 })
      doc.batchSegments[0].speakerWords.push({ word: 'outside usable coverage', speaker: 'Ext', start: 218.9, end: 219.1 })
    })
    const texts = f.scopes.filter(s => s.kind === 'interval-words').flatMap(s => s.members.map(m => m.text))
    expect(texts).not.toContain(f.doc.batchSegments[0].speakerWords[0].word)
    expect(texts).not.toContain(f.doc.batchSegments[0].speakerWords[1].word)
    expect(texts).not.toContain('different identities crossing'); expect(texts).not.toContain('outside usable coverage')
  })
})
