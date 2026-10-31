import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { applyMacCallHumanAnnotation, commitMacCallHumanAnnotation, macCallHumanScopes, macCallHumanPaths } from './mac-speaker-call-human.js'
import { buildMacIntervalHumanScopes, commitMacIntervalHumanAnnotation, macIntervalHumanPaths, undoMacIntervalHumanAnnotation } from './mac-speaker-call-interval-human.js'
import { commitOriginalViewTransaction, inspectOriginalViewTransaction, originalViewPaths, previewOriginalViewTransaction, recoverOriginalViewTransaction } from './mac-speaker-call-original-view.js'
import { bindMacSpeakerShadowRepair, type MacShadowRepairSource } from './mac-speaker-shadow-repair.js'
import { reconcileMacSpeaker256Snapshot } from './mac-speaker-live-memory.js'
import { prepareMacSpeakerCallPacket, resolveMacSpeakerCallView } from './mac-speaker-call-view.js'
import { SYNTHETIC_SECONDS, SYNTHETIC_SPANS, syntheticEmbeddings, syntheticNative } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

const privateRoot = await vi.hoisted(async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cos-original-view-data-'))
  process.env.COS_DATA_DIR = root
  for (const flag of ['COS_MAC_SPEAKER_CALL_PRODUCER', 'COS_MAC_SPEAKER_LIVE', 'COS_TRANSCRIPT_CLEANUP', 'COS_OPENAI_WHISPER_FALLBACK', 'COS_LIVE_CUES', 'COS_LIVE_CUES_V2']) process.env[flag] = '0'
  return root
})
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
afterAll(() => rmSync(privateRoot, { recursive: true, force: true }))

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cos-original-view-')); roots.push(root)
  const captureId = `mac_${randomUUID()}`, files = { sidecarPath: join(root, 'record.g2-chunks.json'), meetingPath: join(root, 'record.md') }
  const interval = macIntervalHumanPaths(files, captureId), legacy = macCallHumanPaths(files, captureId), paths = originalViewPaths(files, captureId)
  mkdirSync(dirname(interval.ledger), { recursive: true, mode: 0o700 })
  const doc = { sessionId: captureId, sourceType: 'mac_system_audio', chunks: [{ speaker: 'Voice 1', text: 'Synthetic words', elapsed: 0 }], chunkEntries: [{ chunkIndex: 0, chunk: { speaker: 'Voice 1', text: 'Synthetic words', elapsed: 0 } }] }
  const base = JSON.stringify(doc), markdown = '# Synthetic\n\n## Transcript\n[Voice 1]: Synthetic words\n'
  writeFileSync(files.sidecarPath, base); writeFileSync(files.meetingPath, markdown); writeFileSync(interval.packet, 'SYNTHETIC AUTOMATIC PACKET')
  const statePath = files.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-state.json')
  writeFileSync(statePath, 'SYNTHETIC AUTOMATIC STATE')
  const unchanged = () => { expect(readFileSync(files.sidecarPath, 'utf8')).toBe(base); expect(readFileSync(files.meetingPath, 'utf8')).toBe(markdown) }
  const preview = () => previewOriginalViewTransaction(files, captureId)
  const commit = (afterWrite?: (index: number) => void) => commitOriginalViewTransaction({ files, captureId, expectedScopeSHA256: preview().scopeSHA256, afterWrite })
  const inspect = () => inspectOriginalViewTransaction(files, captureId)
  return { root, captureId, files, interval, legacy, paths, statePath, base, markdown, unchanged, preview, commit, inspect }
}
function humanFixture(withLegacy = false) {
  const f = fixture(), chunkEntries: any[] = []
  for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
    const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
    const chunk = { speaker: span.label, text: `Synthetic ${raw}`, elapsed: start * 1000, audioDurationMs: seconds * 1000, audioSha256: hash(`wav${raw}`), segments: [{ speaker: span.label, startSec: 0, endSec: seconds }] }
    chunkEntries.push({ chunkIndex: raw, chunk })
  }
  let offset = 0
  const speakerWords = chunkEntries.map(({ chunk }) => { const start = offset; offset += chunk.audioDurationMs / 1000; return { speaker: chunk.speaker, word: chunk.text, start: start + .1, end: start + .2 } })
  const doc = { sessionId: f.captureId, sourceType: 'mac_system_audio', finalizationState: 'complete', batchApplied: true,
    chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, batchSegments: [{ startElapsed: 0, startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
  const base = JSON.stringify(doc), markdown = '# Synthetic\n\n## Transcript\n' + speakerWords.map(w => `[${w.speaker}]: ${w.word}`).join('\n')
  writeFileSync(f.files.sidecarPath, base); writeFileSync(f.files.meetingPath, markdown)
  const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: hash(`pcm${e.chunkIndex}`), sampleCount: e.chunk.audioDurationMs * 16 }))
  const source: MacShadowRepairSource = { originalJSON: base, currentJSON: base, ledgerJSONL: '', rawAudio,
    timeline: { rows: rawAudio.map((r, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: r.sampleCount, usedSampleCount: r.sampleCount })), total: SYNTHETIC_SECONDS * 16000, pcmSHA256: hash('timeline') },
    cohort: { nativeJSON: JSON.stringify(syntheticNative()), embeddingsJSON: JSON.stringify(syntheticEmbeddings()), modelSHA256: hash('model'), cliSHA256: hash('cli') } }
  const packetFor = (policy: 'anonymous-estimate' | 'source-bound-intervals') => {
    const input = { ...source, sourceBindingSHA256: bindMacSpeakerShadowRepair(source), generation: `original-view-${policy}` }
    return prepareMacSpeakerCallPacket(input, reconcileMacSpeaker256Snapshot(null, input), { admission: 'qualified', projectionPolicy: policy,
      ...(policy === 'source-bound-intervals' ? { intervalMembership: 'native-exclusive-members' as const } : {}) })
  }
  let legacyAnnotationJSON: string | null = null
  if (withLegacy) {
    const packet = packetFor('anonymous-estimate'); writeFileSync(f.interval.packet, JSON.stringify(packet))
    const scope = macCallHumanScopes({ baseJSON: base, markdown, ledgerJSONL: '', annotationJSON: null, packet, view: resolveMacSpeakerCallView(base, '', packet) })[0]
    commitMacCallHumanAnnotation({ files: f.files, captureId: f.captureId, scope, selectedRawChunkIndices: [scope.members[0].rawChunkIndex], to: 'Prior Human' })
    source.ledgerJSONL = readFileSync(f.interval.ledger, 'utf8'); legacyAnnotationJSON = readFileSync(f.interval.legacyAnnotation, 'utf8')
  }
  const packet = packetFor('source-bound-intervals'); writeFileSync(f.interval.packet, JSON.stringify(packet))
  const args = { baseJSON: base, markdown, ledgerJSONL: source.ledgerJSONL, legacyAnnotationJSON, annotationJSON: null, packet,
    view: applyMacCallHumanAnnotation(base, source.ledgerJSONL, legacyAnnotationJSON, resolveMacSpeakerCallView(base, source.ledgerJSONL, packet)) }
  const scope = buildMacIntervalHumanScopes(args)[0]
  const named = commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.captureId, scope, memberIds: [scope.members[0].id], to: 'Human Example' })
  const undo = () => {
    const text = readFileSync(f.interval.annotation, 'utf8'), annotation = JSON.parse(text)
    undoMacIntervalHumanAnnotation({ files: f.files, captureId: f.captureId, actionId: named.correctionId, revision: annotation.revision, annotationSHA256: annotation.annotationSHA256 })
  }
  return { ...f, base, markdown, source, undo, args,
    unchanged: () => { expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(base); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(markdown); expect(existsSync(f.interval.ledger) ? readFileSync(f.interval.ledger, 'utf8') : '').toBe(source.ledgerJSONL); expect(existsSync(f.interval.legacyAnnotation) ? readFileSync(f.interval.legacyAnnotation, 'utf8') : null).toBe(legacyAnnotationJSON) } }
}
const interrupted = (index: number) => (actual: number) => { if (actual === index) throw Error(`synthetic interruption ${index}`) }

describe('explicit original-view archive transaction', () => {
  it('archives exact automatic bytes and preserves immutable sources without a human sidecar', () => {
    const f = fixture(), before = f.preview()
    expect(before.artifacts).toEqual(['packet', 'state']); expect(f.inspect()).toEqual({ status: 'absent' })
    const result = f.commit(), archive = join(f.paths.archiveRoot, result.archiveId)
    expect(result).toEqual({ archiveId: before.archiveId, scopeSHA256: before.scopeSHA256 })
    expect(readFileSync(join(archive, 'packet.json'), 'utf8')).toBe('SYNTHETIC AUTOMATIC PACKET')
    expect(readFileSync(join(archive, 'state.json'), 'utf8')).toBe('SYNTHETIC AUTOMATIC STATE'); expect(existsSync(f.statePath)).toBe(false)
    expect(existsSync(f.interval.packet)).toBe(false); expect(existsSync(f.interval.annotation)).toBe(false); expect(existsSync(f.interval.journal)).toBe(false)
    expect(f.inspect()).toEqual({ status: 'complete', archiveId: result.archiveId })
    expect(statSync(f.paths.archiveRoot).mode & 0o077).toBe(0); expect(statSync(archive).mode & 0o077).toBe(0)
    f.unchanged()
  })
  it('also accepts an already original recording with no derived artifacts', () => {
    const f = fixture(); unlinkSync(f.interval.packet); unlinkSync(f.statePath)
    expect(f.preview().artifacts).toEqual([])
    f.commit(); expect(f.inspect().status).toBe('complete'); f.unchanged()
  })
  it('permits exit without a write-up and pins its absence without creating Markdown', () => {
    const f = fixture(); unlinkSync(f.files.meetingPath)
    const scope = f.preview(); f.commit()
    expect(f.inspect()).toEqual({ status: 'complete', archiveId: scope.archiveId })
    expect(existsSync(f.files.meetingPath)).toBe(false); expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.base)
    expect(existsSync(f.interval.packet)).toBe(false); expect(existsSync(f.statePath)).toBe(false)
  })
  it('refuses an inactive annotation whose bound Markdown disappeared', () => {
    const f = humanFixture(); f.undo(); unlinkSync(f.files.meetingPath)
    expect(() => f.preview()).toThrow(); expect(existsSync(f.interval.annotation)).toBe(true); expect(existsSync(f.paths.journal)).toBe(false)
  })
  it('refuses active human decisions and permits the exact inactive epoch after Undo', () => {
    const f = humanFixture()
    expect(() => f.preview()).toThrow('must be undone first'); expect(existsSync(f.paths.journal)).toBe(false)
    f.undo()
    const originals = [f.interval.packet, f.interval.annotation, f.interval.journal].map(path => readFileSync(path, 'utf8'))
    const result = f.commit(), archive = join(f.paths.archiveRoot, result.archiveId)
    expect(['packet.json', 'interval-human.json', 'interval-human-transaction.json'].map(name => readFileSync(join(archive, name), 'utf8'))).toEqual(originals)
    expect(JSON.parse(originals[1]).events.map((e: any) => e.kind)).toEqual(['name', 'undo'])
    f.unchanged()
  })
  it('preserves verified legacy human correction, ledger, and v1 journal byte for byte', () => {
    const f = humanFixture(true); f.undo()
    const legacyBefore = readFileSync(f.legacy.journal, 'utf8')
    f.commit(); f.unchanged(); expect(readFileSync(f.legacy.journal, 'utf8')).toBe(legacyBefore)
    const legacy = applyMacCallHumanAnnotation(f.base, f.source.ledgerJSONL, f.args.legacyAnnotationJSON, resolveMacSpeakerCallView(f.base, f.source.ledgerJSONL, null))
    expect(legacy.doc.chunks.some((c: any) => c.speaker === 'Prior Human')).toBe(true)
  })
  it.each([-1, 0, 1, 2, 3, 4])('retains an immutable prepared intent at interruption %s and completes only that intent', index => {
    const f = humanFixture(); f.undo()
    const before = f.preview()
    expect(() => f.commit(interrupted(index))).toThrow(`synthetic interruption ${index}`)
    expect(f.inspect()).toEqual({ status: 'prepared', archiveId: before.archiveId })
    const prepared = readFileSync(f.paths.journal, 'utf8')
    expect(() => f.commit()).toThrow('recovery required'); expect(readFileSync(f.paths.journal, 'utf8')).toBe(prepared)
    recoverOriginalViewTransaction(f.files, f.captureId)
    expect(f.inspect()).toEqual({ status: 'complete', archiveId: before.archiveId })
    for (const path of [f.interval.packet, f.interval.annotation, f.interval.journal, f.statePath]) expect(existsSync(path)).toBe(false)
    f.unchanged()
  })
  it.each(['base', 'markdown', 'ledger', 'packet', 'annotation', 'journal', 'state'])('rejects a stale reviewed %s before archiving or removing any artifact', kind => {
    const f = fixture(), before = f.preview(), target = ({ base: f.files.sidecarPath, markdown: f.files.meetingPath, ledger: f.interval.ledger, packet: f.interval.packet, annotation: f.interval.annotation, journal: f.interval.journal, state: f.statePath } as Record<string, string>)[kind]
    writeFileSync(target, kind === 'base' ? JSON.stringify({ ...JSON.parse(f.base), changed: true }) : 'changed synthetic bytes')
    expect(() => commitOriginalViewTransaction({ files: f.files, captureId: f.captureId, expectedScopeSHA256: before.scopeSHA256 })).toThrow()
    expect(existsSync(f.paths.journal)).toBe(false); expect(existsSync(f.paths.archiveRoot)).toBe(false)
    expect(existsSync(f.interval.packet)).toBe(true)
  })
  it('refuses changed sources during recovery, then recovers after exact source restoration', () => {
    const f = fixture(); expect(() => f.commit(interrupted(-1))).toThrow()
    writeFileSync(f.files.meetingPath, 'changed source')
    expect(f.inspect().status).toBe('recovery-invalid'); expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow('source changed')
    expect(existsSync(f.interval.packet)).toBe(true)
    writeFileSync(f.files.meetingPath, f.markdown); recoverOriginalViewTransaction(f.files, f.captureId)
    expect(f.inspect().status).toBe('complete'); f.unchanged()
  })
  it('refuses a later interval artifact rather than removing unreviewed bytes', () => {
    const f = fixture(); expect(() => f.commit(interrupted(-1))).toThrow()
    writeFileSync(f.interval.packet, 'NEW UNREVIEWED PACKET')
    expect(f.inspect().status).toBe('recovery-invalid'); expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow('later interval artifact changed')
    expect(readFileSync(f.interval.packet, 'utf8')).toBe('NEW UNREVIEWED PACKET')
  })
  it('refuses corrupt archive bytes and malformed or falsely complete markers', () => {
    const f = fixture(); expect(() => f.commit(interrupted(-1))).toThrow()
    const marker = JSON.parse(readFileSync(f.paths.journal, 'utf8'))
    writeFileSync(join(f.paths.archiveRoot, marker.archiveId, 'packet.json'), 'CORRUPT ARCHIVE')
    expect(f.inspect().status).toBe('recovery-invalid'); expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow('archived artifact changed')
    for (const text of ['CORRUPT JSON', JSON.stringify({ phase: 'complete' })]) {
      writeFileSync(f.paths.journal, text); expect(f.inspect().status).toBe('recovery-invalid'); expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow()
    }
    expect(existsSync(f.interval.packet)).toBe(true)
  })
  it('refuses a rehashed false completion before removals without a durable completion receipt', () => {
    const f = fixture(); expect(() => f.commit(interrupted(-1))).toThrow()
    const prepared = readFileSync(f.paths.journal, 'utf8'), value = JSON.parse(prepared)
    value.phase = 'complete'; const { journalSHA256: _, ...body } = value; value.journalSHA256 = hash(JSON.stringify(body))
    writeFileSync(f.paths.journal, JSON.stringify(value))
    expect(f.inspect().status).toBe('recovery-invalid'); expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow()
    expect(existsSync(f.interval.packet)).toBe(true); expect(existsSync(f.statePath)).toBe(true)
    writeFileSync(f.paths.journal, prepared); recoverOriginalViewTransaction(f.files, f.captureId); expect(f.inspect().status).toBe('complete')
  })
  it('refuses a corrupted immutable completion receipt after a successful exit', () => {
    const f = fixture(), result = f.commit()
    writeFileSync(join(f.paths.archiveRoot, result.archiveId, 'complete.json'), 'CORRUPT COMPLETION')
    expect(f.inspect().status).toBe('recovery-invalid'); expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow('archived completion changed')
    f.unchanged()
  })
  it('does not pin completed history to later BASE, Markdown, legacy decisions, ledger or automatic packets', () => {
    const f = fixture(); f.commit()
    writeFileSync(f.files.sidecarPath, JSON.stringify({ ...JSON.parse(f.base), changed: true })); writeFileSync(f.files.meetingPath, 'later markdown')
    writeFileSync(f.interval.ledger, 'later ledger'); writeFileSync(f.interval.legacyAnnotation, 'later human decision'); writeFileSync(f.interval.packet, 'later automatic packet')
    expect(f.inspect().status).toBe('complete')
    recoverOriginalViewTransaction(f.files, f.captureId)
    expect(readFileSync(f.interval.packet, 'utf8')).toBe('later automatic packet')
  })
  it('archives a later epoch and retains the previous completed receipt', () => {
    const f = fixture(), first = f.commit(), receipt = readFileSync(f.paths.journal, 'utf8')
    writeFileSync(f.interval.packet, 'second automatic packet')
    const second = f.commit()
    expect(second.archiveId).not.toBe(first.archiveId)
    expect(readFileSync(join(f.paths.archiveRoot, second.archiveId, 'previous-transaction.json'), 'utf8')).toBe(receipt)
    expect(readFileSync(join(f.paths.archiveRoot, first.archiveId, 'packet.json'), 'utf8')).toBe('SYNTHETIC AUTOMATIC PACKET')
    expect(f.inspect().status).toBe('complete')
  })
  it('uses the existing capture lock and never steals a foreign or living lock', () => {
    const f = fixture(), scope = f.preview().scopeSHA256
    expect(f.paths.lock).toBe(f.interval.lock)
    for (const lock of ['FOREIGN', JSON.stringify({ kind: 'mac-speaker-call-original-view-v1', journal: f.paths.journal, pid: process.pid })]) {
      writeFileSync(f.paths.lock, lock)
      expect(() => commitOriginalViewTransaction({ files: f.files, captureId: f.captureId, expectedScopeSHA256: scope })).toThrow('capture locked')
      expect(readFileSync(f.paths.lock, 'utf8')).toBe(lock)
    }
    unlinkSync(f.paths.lock)
    expect(() => f.commit(interrupted(-1))).toThrow()
    const live = JSON.stringify({ kind: 'mac-speaker-call-original-view-v1', journal: f.paths.journal, pid: process.pid })
    writeFileSync(f.paths.lock, live)
    expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow('owner alive'); expect(readFileSync(f.paths.lock, 'utf8')).toBe(live)
  })
  it.each(['archive-root', 'archive-epoch', 'archive-file', 'marker', 'capture-lock'])('refuses a symlink %s without changing its referent', kind => {
    const f = fixture(), target = join(f.root, 'untouched'); writeFileSync(target, 'untouched')
    const scope = f.preview()
    if (kind === 'archive-root') symlinkSync(f.root, f.paths.archiveRoot)
    if (kind === 'archive-epoch') { mkdirSync(f.paths.archiveRoot, { mode: 0o700 }); symlinkSync(f.root, join(f.paths.archiveRoot, scope.archiveId)) }
    if (kind === 'archive-file') { mkdirSync(join(f.paths.archiveRoot, scope.archiveId), { recursive: true, mode: 0o700 }); symlinkSync(target, join(f.paths.archiveRoot, scope.archiveId, 'packet.json')) }
    if (kind === 'marker') symlinkSync(target, f.paths.journal)
    if (kind === 'capture-lock') symlinkSync(target, f.paths.lock)
    expect(() => commitOriginalViewTransaction({ files: f.files, captureId: f.captureId, expectedScopeSHA256: scope.scopeSHA256 })).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('untouched'); expect(existsSync(f.interval.packet)).toBe(true)
  })
  it('refuses unfinished legacy or interval human journals rather than bypassing recovery', () => {
    const f = humanFixture(true); f.undo()
    const original = readFileSync(f.legacy.journal, 'utf8'), value = JSON.parse(original)
    value.phase = 'prepared'; const { journalSHA256: _, ...body } = value; value.journalSHA256 = hash(JSON.stringify(body))
    writeFileSync(f.legacy.journal, JSON.stringify(value))
    expect(() => f.preview()).toThrow('legacy human recovery required')
    writeFileSync(f.legacy.journal, original); writeFileSync(f.interval.journal, JSON.stringify({ phase: 'prepared' }))
    expect(() => f.preview()).toThrow('interval human recovery required')
    expect(existsSync(f.paths.journal)).toBe(false)
  })
  it('never creates an intent on recovery of an absent transaction', () => {
    const f = fixture(); recoverOriginalViewTransaction(f.files, f.captureId)
    expect(f.inspect()).toEqual({ status: 'absent' }); expect(existsSync(f.paths.archiveRoot)).toBe(false); expect(existsSync(f.paths.lock)).toBe(false)
  })
  it('recovers only a dead lock owned by this exact original-view transaction', () => {
    const f = fixture(); expect(() => f.commit(interrupted(-1))).toThrow()
    const foreign = JSON.stringify({ kind: 'mac-speaker-call-interval-human-v1', journal: f.interval.journal, pid: 987654321 })
    writeFileSync(f.paths.lock, foreign)
    expect(() => recoverOriginalViewTransaction(f.files, f.captureId)).toThrow('foreign capture lock')
    expect(readFileSync(f.paths.lock, 'utf8')).toBe(foreign)
    writeFileSync(f.paths.lock, JSON.stringify({ kind: 'mac-speaker-call-original-view-v1', journal: f.paths.journal, pid: 987654321 }))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('synthetic dead owner'), { code: 'ESRCH' }) })
    try { recoverOriginalViewTransaction(f.files, f.captureId) } finally { kill.mockRestore() }
    expect(f.inspect().status).toBe('complete'); expect(existsSync(f.paths.lock)).toBe(false)
  })
  it('recovers an owned dead lock left before intent publication without creating an intent or moving artifacts', () => {
    const f = fixture(), lock = JSON.stringify({ kind: 'mac-speaker-call-original-view-v1', journal: f.paths.journal, pid: 987654321 })
    writeFileSync(f.paths.lock, lock)
    expect(f.inspect().status).toBe('recovery-invalid')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('synthetic dead owner'), { code: 'ESRCH' }) })
    try { recoverOriginalViewTransaction(f.files, f.captureId) } finally { kill.mockRestore() }
    expect(f.inspect()).toEqual({ status: 'absent' }); expect(existsSync(f.paths.lock)).toBe(false); expect(existsSync(f.paths.journal)).toBe(false)
    expect(readFileSync(f.interval.packet, 'utf8')).toBe('SYNTHETIC AUTOMATIC PACKET'); expect(existsSync(f.statePath)).toBe(true); f.unchanged()
  })
  it('exposes and clears an owned dead preparation lock even when an older completed receipt remains', () => {
    const f = fixture(); f.commit(); writeFileSync(f.interval.packet, 'later automatic packet')
    writeFileSync(f.paths.lock, JSON.stringify({ kind: 'mac-speaker-call-original-view-v1', journal: f.paths.journal, pid: 987654321 }))
    expect(f.inspect().status).toBe('recovery-invalid')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('synthetic dead owner'), { code: 'ESRCH' }) })
    try { recoverOriginalViewTransaction(f.files, f.captureId) } finally { kill.mockRestore() }
    expect(f.inspect().status).toBe('complete'); expect(readFileSync(f.interval.packet, 'utf8')).toBe('later automatic packet')
  })
  it('refuses a noncanonical recording parent and another capture source', () => {
    const f = fixture(), parentLink = join(f.root, 'linked-parent')
    symlinkSync(f.root, parentLink)
    expect(() => previewOriginalViewTransaction({ sidecarPath: join(parentLink, 'record.g2-chunks.json'), meetingPath: join(parentLink, 'record.md') }, f.captureId)).toThrow('canonical parent')
    writeFileSync(f.files.sidecarPath, JSON.stringify({ ...JSON.parse(f.base), sessionId: `mac_${randomUUID()}` }))
    expect(() => f.preview()).toThrow('capture source mismatch'); expect(existsSync(f.interval.packet)).toBe(true)
  })
})
