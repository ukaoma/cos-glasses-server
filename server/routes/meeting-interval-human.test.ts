/** Actual HTTP coverage over generated source bytes and the real call-view reader.
 * No recorded audio, native runtime, producer, profile store or reader mock. */
import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { bindMacSpeakerShadowRepair, type MacShadowRepairSource } from '../lib/mac-speaker-shadow-repair.js'
import { reconcileMacSpeaker256Snapshot } from '../lib/mac-speaker-live-memory.js'
import { prepareMacSpeakerCallPacket, readMacSpeakerCallView, resolveMacSpeakerCallView } from '../lib/mac-speaker-call-view.js'
import { commitMacCallHumanAnnotation, macCallHumanPaths, macCallHumanScopes } from '../lib/mac-speaker-call-human.js'
import { buildMacIntervalHumanScopes, commitMacIntervalHumanAnnotation, macIntervalHumanPaths } from '../lib/mac-speaker-call-interval-human.js'
import { commitOriginalViewTransaction, inspectOriginalViewTransaction, originalViewPaths, previewOriginalViewTransaction } from '../lib/mac-speaker-call-original-view.js'
import { SYNTHETIC_SECONDS, SYNTHETIC_SPANS, syntheticEmbeddings, syntheticNative } from '../lib/__fixtures__/speaker-shadow/synthetic-meeting.js'

const privateRoot = await vi.hoisted(async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cos-interval-http-private-'))
  process.env.COS_DATA_DIR = path.join(root, 'data'); fs.mkdirSync(process.env.COS_DATA_DIR, { mode: 0o700 })
  process.env.COS_PROFILE_PATH = path.join(root, 'unused-profile.json')
  for (const flag of ['COS_MAC_SPEAKER_CALL_PRODUCER', 'COS_MAC_SPEAKER_LIVE', 'COS_TRANSCRIPT_CLEANUP', 'COS_OPENAI_WHISPER_FALLBACK', 'COS_LIVE_CUES', 'COS_LIVE_CUES_V2']) process.env[flag] = '0'
  delete process.env.COS_OPERATIONS_DIR; delete process.env.COS_MEETINGS_ROOT; delete process.env.COS_SCRIPTS_DIR
  return root
})
vi.mock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU', getOwnerName: () => 'Fixture Owner', getVocabulary: () => [], getTranscriptionProfileStatus: () => ({}) }))

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})
afterAll(() => rmSync(privateRoot, { recursive: true, force: true }))

async function fixture(withLegacy = false, editDoc?: (doc: any) => void) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cos-interval-http-')); roots.push(root)
  const sid = `mac_${randomUUID()}`, chunkEntries: any[] = []
  for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
    const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
    const chunk = { text: `fictional source ${raw}`, speaker: span.label, elapsed: start * 1000, audioDurationMs: seconds * 1000,
      audioSha256: hash(`wav${raw}`), segments: [{ speaker: span.label, startSec: 0, endSec: seconds }], similarity: 0 }
    chunkEntries.push({ chunkIndex: raw, chunk })
  }
  let offset = 0
  const speakerWords = chunkEntries.flatMap(({ chunk }) => {
    const start = offset; offset += chunk.audioDurationMs / 1000
    // Fractional milliseconds exercise the real server wire instead of only round synthetic clocks.
    return [0, 1].map(i => ({ word: `${chunk.text} token ${i}`, speaker: chunk.speaker, start: start + .1234375 + i * .2,
      end: start + .2234375 + i * .2, confidence: .87 }))
  })
  const doc: any = { sessionId: sid, title: 'Synthetic interval HTTP call', startTime: Date.UTC(2026, 9, 30), durationMs: SYNTHETIC_SECONDS * 1000,
    sourceType: 'mac_system_audio', finalizationState: 'complete', batchApplied: true, correctionRevision: 1,
    chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, speakers: ['Dana Fictional'],
    batchSegments: [{ startElapsed: 0, startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
  editDoc?.(doc)
  const baseJSON = JSON.stringify(doc), markdown = '# Synthetic interval HTTP call\n\n## Transcript\n' + doc.batchSegments.flatMap((b: any) => b.speakerWords).map((w: any) => `[${w.speaker}]: ${w.word}`).join('\n') + '\n'
  const files = { sidecarPath: join(root, 'record.g2-chunks.json'), meetingPath: join(root, 'record.md') }, paths = macIntervalHumanPaths(files, sid), legacyPaths = macCallHumanPaths(files, sid)
  mkdirSync(dirname(paths.ledger), { recursive: true }); writeFileSync(files.sidecarPath, baseJSON); writeFileSync(files.meetingPath, markdown)
  const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: hash(`pcm${e.chunkIndex}`), sampleCount: e.chunk.audioDurationMs * 16 }))
  const source: MacShadowRepairSource = { originalJSON: baseJSON, currentJSON: baseJSON, ledgerJSONL: '', rawAudio,
    timeline: { rows: rawAudio.map((r, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: r.sampleCount, usedSampleCount: r.sampleCount })), total: SYNTHETIC_SECONDS * 16000, pcmSHA256: hash('timeline') },
    cohort: { nativeJSON: JSON.stringify(syntheticNative()), embeddingsJSON: JSON.stringify(syntheticEmbeddings()), modelSHA256: hash('model'), cliSHA256: hash('cli') } }
  const packetFor = (projectionPolicy: 'anonymous-estimate' | 'source-bound-intervals') => {
    const input = { ...source, sourceBindingSHA256: bindMacSpeakerShadowRepair(source), generation: `synthetic-http-${projectionPolicy}` }
    const state = reconcileMacSpeaker256Snapshot(null, input)
    return prepareMacSpeakerCallPacket(input, state, { admission: 'qualified', projectionPolicy,
      ...(projectionPolicy === 'source-bound-intervals' ? { intervalMembership: 'native-exclusive-members' as const } : {}) })
  }
  let priorLegacyScope: any = null
  if (withLegacy) {
    const packet = packetFor('anonymous-estimate'); writeFileSync(paths.packet, JSON.stringify(packet))
    const scopes = macCallHumanScopes({ baseJSON, markdown, ledgerJSONL: '', annotationJSON: null, packet, view: resolveMacSpeakerCallView(baseJSON, '', packet) })
    const scope = scopes.find(s => s.members.some(m => m.before === 'Voice 2')) ?? scopes[0]
    if (!scope) throw Error('HTTP fixture has no legacy human scope')
    commitMacCallHumanAnnotation({ files, captureId: sid, scope, selectedRawChunkIndices: [scope.members[0].rawChunkIndex], to: 'Prior Human' })
    source.ledgerJSONL = readFileSync(paths.ledger, 'utf8')
    const annotationJSON = readFileSync(paths.legacyAnnotation, 'utf8')
    priorLegacyScope = macCallHumanScopes({ baseJSON, markdown, ledgerJSONL: source.ledgerJSONL, annotationJSON, packet: null,
      view: readMacSpeakerCallView(files.sidecarPath, baseJSON, files.meetingPath) }).find(s => s.kind === 'human')
  }
  const packet = packetFor('source-bound-intervals'); writeFileSync(paths.packet, JSON.stringify(packet))
  const original = { base: baseJSON, markdown, ledger: existsSync(paths.ledger) ? readFileSync(paths.ledger, 'utf8') : null,
    legacy: existsSync(paths.legacyAnnotation) ? readFileSync(paths.legacyAnnotation, 'utf8') : null, packet: readFileSync(paths.packet, 'utf8') }
  const { createMeetingRouter } = await import('./meeting.js')
  const saved = { sidecarPath: files.sidecarPath, filepath: files.meetingPath, title: 'Synthetic interval HTTP call', domain: 'personal', filename: 'record.md', durationMin: 6 }
  const app = express(); app.use(express.json({ limit: '10mb' })); app.use('/api', createMeetingRouter({ store: { findBySessionId: (id: string) => id === sid ? saved : null } as any }))
  const server = app.listen(0, '127.0.0.1'); servers.push(server)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('private loopback unavailable')
  const baseURL = `http://127.0.0.1:${address.port}/api/meeting/${sid}`, recordId = `standalone:${sid}`
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(baseURL + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as any }
  }
  const panel = () => request(`/speakers?recordId=${encodeURIComponent(recordId)}`)
  const content = () => request(`/content?recordId=${encodeURIComponent(recordId)}`)
  const selection = (review: any, scope = review.intervalGroupScopes.find((s: any) => s.kind === 'interval-words'), to = 'Human Example') => ({ path: `/speaker-interval-groups/${scope.identityId}/relabel`,
    body: { recordId, expectedRevision: review.sourceRevision, scopeSHA256: scope.scopeSHA256, memberIds: [scope.members[0].id], to }, member: scope.members[0] })
  const profilePaths = ['voice-profiles.json', 'voice-profiles.json.bak'].map(name => join(privateRoot, 'data', name))
  const profiles = profilePaths.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null)
  const assertImmutable = () => {
    expect(readFileSync(files.sidecarPath, 'utf8')).toBe(original.base); expect(readFileSync(files.meetingPath, 'utf8')).toBe(original.markdown)
    expect(existsSync(paths.ledger) ? readFileSync(paths.ledger, 'utf8') : null).toBe(original.ledger)
    expect(existsSync(paths.legacyAnnotation) ? readFileSync(paths.legacyAnnotation, 'utf8') : null).toBe(original.legacy)
    expect(profilePaths.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null)).toEqual(profiles)
  }
  return { sid, files, paths, legacyPaths, doc, packet, original, recordId, priorLegacyScope, request, panel, content, selection, assertImmutable }
}

async function nameOne(f: Awaited<ReturnType<typeof fixture>>, to = 'Human Example') {
  const review = (await f.panel()).body
  expect(review.intervalGroupScopes.length).toBeGreaterThan(0)
  const selected = f.selection(review, undefined, to)
  const preview = await f.request(selected.path, { ...selected.body, dryRun: true })
  expect(preview.status).toBe(200); expect(preview.body.preview.members).toEqual([selected.member])
  const saved = await f.request(selected.path, { ...selected.body, confirm: true })
  expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ ok: true, confirmed: true, enrollmentAllowed: false, correction: { members: 1, fields: 1 } })
  return { review, selected, saved }
}
function undoBody(f: Awaited<ReturnType<typeof fixture>>, review: any, actionId: string) {
  return { recordId: f.recordId, expectedRevision: review.sourceRevision, actionId,
    annotationRevision: review.intervalHumanAnnotation.revision, annotationSHA256: review.intervalHumanAnnotation.annotationSHA256, confirm: true }
}

describe('actual HTTP exact interval human naming with producer disabled', () => {
  it('previews and saves successive exact words; Speakers and content/copy agree without touching source surfaces', async () => {
    const f = await fixture(), before = await f.panel(), choice = f.selection(before.body)
    expect(process.env.COS_MAC_SPEAKER_CALL_PRODUCER).toBe('0')
    expect(choice.member.startElapsedMs % 1).not.toBe(0)
    expect((await f.request(`/speaker-interval-groups?recordId=${encodeURIComponent(f.recordId)}`)).body.intervalGroupScopes).toEqual(before.body.intervalGroupScopes)
    const preview = await f.request(choice.path, { ...choice.body, dryRun: true })
    expect(preview.status).toBe(200); expect(existsSync(f.paths.annotation)).toBe(false)
    await nameOne(f)
    await nameOne(f, 'Second Person')
    const review = (await f.panel()).body, content = (await f.content()).body
    expect(review.intervalHumanAnnotation.activeActions).toHaveLength(2)
    for (const label of ['Human Example', 'Second Person']) {
      expect(review.voices.find((v: any) => v.label === label)).toMatchObject({ nameAsserted: true, confirmedByHuman: true, segments: 0, confirmedSegments: 0, confirmedWordCount: 1, wordCount: 1, speakingMs: 100 })
      expect(content.attendees.find((v: any) => v.label === label)).toMatchObject({ asserted: true, confirmedByHuman: true, speakingMs: 100 })
      expect(content.clipboardFull).toContain(`[${label}]:`)
    }
    expect(content.effectiveSpeakerSummary).toEqual(review.effectiveSpeakerSummary)
    expect(review.voicedMs + review.notCapturedMs).toBe(SYNTHETIC_SECONDS * 1000)
    expect(review.speakerCallView.intervalHumanAnnotation.confirmedWords).toHaveLength(2)
    expect(readFileSync(f.paths.packet, 'utf8')).toBe(f.original.packet)
    f.assertImmutable()
  }, 30_000)

  it('undoes one of two names without discarding the remaining exact claim or the final closed word inventory', async () => {
    const f = await fixture(), first = await nameOne(f), second = await nameOne(f, 'Second Person')
    const both = (await f.panel()).body
    const firstUndo = await f.request('/speaker-interval-groups/undo', undoBody(f, both, first.saved.body.correction.correctionId))
    expect(firstUndo.status).toBe(200)
    const partial = (await f.panel()).body, partialContent = (await f.content()).body
    expect(partial.intervalHumanAnnotation.activeActions.map((a: any) => a.actionId)).toEqual([second.saved.body.correction.correctionId])
    expect(partial.voices.some((v: any) => v.label === 'Human Example')).toBe(false)
    expect(partial.voices.find((v: any) => v.label === 'Second Person')).toMatchObject({ nameAsserted: true, confirmedByHuman: true, confirmedWordCount: 1, wordCount: 1, speakingMs: 100 })
    expect(partialContent.clipboardFull).not.toContain('[Human Example]:')
    expect(partialContent.clipboardFull).toContain('[Second Person]:')
    expect(partialContent.effectiveSpeakerSummary).toEqual(partial.effectiveSpeakerSummary)
    const secondUndo = await f.request('/speaker-interval-groups/undo', undoBody(f, partial, second.saved.body.correction.correctionId))
    expect(secondUndo.status).toBe(200)
    const final = (await f.panel()).body
    expect(final.intervalHumanAnnotation.activeActions).toEqual([])
    expect(final.speakerCallView.intervalHumanAnnotation.confirmedWords).toEqual([])
    expect(final.effectiveSpeakerSummary).toBeDefined()
    expect(final.voicedMs + final.notCapturedMs).toBe(SYNTHETIC_SECONDS * 1000)
    expect(final.voices.some((v: any) => ['Human Example', 'Second Person'].includes(v.label))).toBe(false)
    f.assertImmutable()
  }, 30_000)

  it('rejects invalid selection, source confusion, unexpected mutation options and stale previews before another write', async () => {
    const f = await fixture(), review = (await f.panel()).body, s = f.selection(review)
    for (const patch of [{ memberIds: [] }, { memberIds: [s.member.id, s.member.id] }, { expectedRevision: 'bad' }, { assignVoiceProfile: true }, { force: true }, { dryRun: true, confirm: true }]) {
      expect((await f.request(s.path, { ...s.body, dryRun: true, ...patch })).status).toBe(400)
    }
    expect((await f.request(s.path, { ...s.body, dryRun: true, recordId: 'standalone:other' })).status).toBe(409)
    expect((await f.request(s.path, { ...s.body, dryRun: true, memberIds: [hash('not-a-member')] })).status).toBe(409)
    const first = await f.request(s.path, { ...s.body, confirm: true }); expect(first.status).toBe(200)
    const after = readFileSync(f.paths.annotation, 'utf8')
    expect((await f.request(s.path, { ...s.body, confirm: true })).status).toBe(409)
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(after)
    f.assertImmutable()
  }, 30_000)

  it.each(['missing', 'corrupt'] as const)('keeps human names and supports Undo after the automatic packet becomes %s', async packetState => {
    const f = await fixture(), named = await nameOne(f)
    if (packetState === 'missing') unlinkSync(f.paths.packet); else writeFileSync(f.paths.packet, 'CORRUPT AUTOMATIC PACKET')
    const review = (await f.panel()).body
    expect(review.voices.find((v: any) => v.label === 'Human Example')).toMatchObject({ nameAsserted: true, wordCount: 1, segments: 0 })
    const active = review.intervalHumanAnnotation.activeActions[0]
    const rename = review.intervalGroupScopes.find((scope: any) => scope.kind === 'human-words' && scope.identityId === active.identityId)
    expect(rename).toMatchObject({ displayLabel: 'Human Example', members: [named.selected.member] })
    expect(review.intervalGroupScopes.some((scope: any) => scope.kind === 'interval-words')).toBe(false)
    expect((await f.content()).body.clipboardFull).toContain('[Human Example]:')
    const undone = await f.request('/speaker-interval-groups/undo', undoBody(f, review, named.saved.body.correction.correctionId))
    expect(undone.status).toBe(200); expect(undone.body.correction.undone).toBe(true)
    const after = (await f.panel()).body
    expect(after.intervalHumanAnnotation.activeActions).toEqual([])
    expect(after.effectiveSpeakerSummary).toBeDefined()
    expect(after.voices.some((v: any) => v.label === 'Human Example')).toBe(false)
    expect((await f.content()).body.clipboardFull).not.toContain('[Human Example]:')
    f.assertImmutable()
  }, 30_000)

  it('refuses legacy scoped corrections with interval decisions after packet withdrawal, preserving the earlier v1 correction', async () => {
    const f = await fixture(true), named = await nameOne(f)
    unlinkSync(f.paths.packet)
    const review = (await f.panel()).body
    expect(review.voices.find((v: any) => v.label === 'Prior Human')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
    expect(review.groupScopes).toEqual([])
    const legacy = f.priorLegacyScope
    const blocked = await f.request(`/speaker-groups/${legacy.identityId}/relabel`, { recordId: f.recordId, expectedRevision: review.sourceRevision,
      scopeSHA256: legacy.scopeSHA256, rawChunkIndices: [legacy.members[0].rawChunkIndex], to: 'Other Person', confirm: true })
    expect(blocked.status).toBe(409)
    expect((await f.request('/speaker-groups/recover', { recordId: f.recordId, confirm: true })).status).toBe(409)
    expect((await f.content()).body.clipboardFull).toContain('[Prior Human]:')
    expect((await f.panel()).body.intervalHumanAnnotation.activeActions[0].actionId).toBe(named.saved.body.correction.correctionId)
    f.assertImmutable()
  }, 30_000)

  it('flags an interrupted publication, retains prior legacy labels, and recovers through the explicit HTTP action', async () => {
    const f = await fixture(true), view = readMacSpeakerCallView(f.files.sidecarPath, f.original.base, f.files.meetingPath)
    const scopes = buildMacIntervalHumanScopes({ baseJSON: f.original.base, markdown: f.original.markdown, ledgerJSONL: f.original.ledger ?? '',
      legacyAnnotationJSON: f.original.legacy, annotationJSON: null, packet: f.packet, view })
    expect(() => commitMacIntervalHumanAnnotation({ files: f.files, captureId: f.sid, scope: scopes[0], memberIds: [scopes[0].members[0].id], to: 'Human Example',
      afterWrite: () => { throw Error('synthetic interrupted publication') } })).toThrow('synthetic interrupted publication')
    const pending = (await f.panel()).body
    expect(pending.intervalHumanRecoveryRequired).toBe(true)
    expect(pending.intervalGroupScopes).toEqual([])
    expect(pending.voices.find((v: any) => v.label === 'Prior Human')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
    expect(pending.voices.some((v: any) => v.label === 'Human Example')).toBe(false)
    expect((await f.content()).body.clipboardFull).toContain('[Prior Human]:')
    const recover = await f.request('/speaker-interval-groups/recover', { recordId: f.recordId, confirm: true })
    expect(recover.status).toBe(200)
    const recovered = (await f.panel()).body
    expect(recovered.intervalHumanRecoveryRequired).toBe(false)
    expect(recovered.voices.find((v: any) => v.label === 'Human Example')).toMatchObject({ nameAsserted: true, confirmedWordCount: 1 })
    f.assertImmutable()
  }, 30_000)

  it.each(['invalid-json', 'false-complete'] as const)('flags a malformed %s journal and refuses recovery or legacy writes', async malformed => {
    const f = await fixture(true); await nameOne(f)
    writeFileSync(f.paths.journal, malformed === 'invalid-json' ? 'CORRUPT JOURNAL' : JSON.stringify({ phase: 'complete' }))
    const review = (await f.panel()).body
    expect(review.intervalHumanRecoveryRequired).toBe(true)
    expect(review.intervalGroupScopes).toEqual([])
    expect(review.voices.find((v: any) => v.label === 'Prior Human')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
    expect((await f.request('/speaker-interval-groups/recover', { recordId: f.recordId, confirm: true })).status).toBe(409)
    expect((await f.request('/relabel', { recordId: f.recordId, expectedRevision: review.sourceRevision, from: 'Voice 1', to: 'Other Person', dryRun: true })).status).toBe(409)
    f.assertImmutable()
  }, 30_000)

  it('names one contiguous unresolved passage and refuses protected gaps or batch crossings without broadening the words', async () => {
    const f = await fixture(false, doc => {
      const raw = doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 9')
      doc.batchSegments[0].speakerWords.splice((raw + 1) * 2 + 1, 0,
        { word: 'protected synthetic gap', start: 209.25, end: 209.275, speaker: 'Ext', confirmedByHuman: true })
      doc.batchSegments.push({ startElapsed: 0, startChunkIdx: 0, endChunkIdx: doc.chunkEntries.length - 1,
        speakerWords: [{ word: 'another batch unresolved', start: 203.5234375, end: 203.6234375, speaker: 'Ext' }] })
    })
    const review = (await f.panel()).body, scope = review.intervalGroupScopes.find((s: any) => s.kind === 'unresolved-words')
    expect(scope).toMatchObject({ identityId: 'unresolved', displayLabel: 'Unresolved speech' })
    expect(scope.selectionRuns.flat()).toEqual(scope.members.map((m: any) => m.id))
    expect(new Set(scope.selectionRuns.flat()).size).toBe(scope.members.length)
    expect(scope.members.some((m: any) => m.text === 'protected synthetic gap')).toBe(false)
    const raw = f.doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 9')
    const member = (text: string) => scope.members.find((m: any) => m.text === text)
    const first = member(`fictional source ${raw} token 0`), second = member(`fictional source ${raw} token 1`)
    const gapLeft = second, gapRight = member(`fictional source ${raw + 2} token 0`)
    expect(scope.members.some((m: any) => m.text.startsWith(`fictional source ${raw + 1} token `))).toBe(false)
    const otherBatch = member('another batch unresolved')
    for (const [label, value] of Object.entries({ first, second, gapLeft, gapRight, otherBatch })) expect(value, `unresolved member ${label}: ${scope.members.map((m: any) => m.text).filter((text: string) => text.includes('another batch') || text.includes(`source ${raw}`) || text.includes(`source ${raw + 2}`)).join('; ')}`).toBeDefined()
    const path = '/speaker-interval-groups/unresolved/relabel', base = { recordId: f.recordId, expectedRevision: review.sourceRevision, scopeSHA256: scope.scopeSHA256, to: 'Manual Person' }
    for (const memberIds of [[gapLeft.id, gapRight.id], [first.id, otherBatch.id], [first.id, gapRight.id]]) {
      for (const flag of ['dryRun', 'confirm']) expect((await f.request(path, { ...base, memberIds, [flag]: true })).status).toBe(409)
      expect(existsSync(f.paths.annotation)).toBe(false)
    }
    expect((await f.request(path, { ...base, memberIds: [first.id, hash('protected synthetic gap')], dryRun: true })).status).toBe(409)
    const preview = await f.request(path, { ...base, memberIds: [second.id, first.id], dryRun: true })
    expect(preview.status).toBe(200); expect(preview.body.preview.members).toEqual([first, second]); expect(preview.body.preview.enrollmentAllowed).toBe(false)
    expect(existsSync(f.paths.annotation)).toBe(false)
    const applied = await f.request(path, { ...base, memberIds: [first.id, second.id], confirm: true })
    expect(applied.status).toBe(200); expect(applied.body.correction).toMatchObject({ members: 2, fields: 2 })
    const after = (await f.panel()).body, content = (await f.content()).body
    expect(after.intervalHumanAnnotation.activeActions).toMatchObject([{ actionId: applied.body.correction.correctionId, to: 'Manual Person', memberIds: [first.id, second.id] }])
    expect(after.voices.find((voice: any) => voice.label === 'Manual Person')).toMatchObject({ confirmedByHuman: true, wordCount: 2 })
    expect(content.clipboardFull).toContain(`[Manual Person]: ${first.text}`); expect(content.clipboardFull).toContain(second.text)
    const unresolved = after.intervalGroupScopes.find((s: any) => s.kind === 'unresolved-words')
    expect(unresolved.members.some((m: any) => [first.id, second.id].includes(m.id))).toBe(false)
    expect(unresolved.members.some((m: any) => m.id === gapRight.id)).toBe(true)
    const confirmedBytes = readFileSync(f.paths.annotation, 'utf8')
    expect((await f.request(path, { ...base, expectedRevision: after.sourceRevision, scopeSHA256: unresolved.scopeSHA256, memberIds: [first.id], confirm: true })).status).toBe(409)
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(confirmedBytes)
    expect((await f.request(path, { ...base, memberIds: [first.id, second.id], confirm: true })).status).toBe(409)
    f.assertImmutable()
  }, 30_000)

  it.each(['missing', 'corrupt'] as const)('atomically renames an active exact action and restores its predecessor through Undo with a %s packet', async packetState => {
    const f = await fixture(), initial = (await f.panel()).body
    const scope = initial.intervalGroupScopes.find((s: any) => s.kind === 'interval-words' && s.members.length >= 2), members = scope.members.slice(0, 2)
    const first = await f.request(`/speaker-interval-groups/${scope.identityId}/relabel`, {
      recordId: f.recordId, expectedRevision: initial.sourceRevision, scopeSHA256: scope.scopeSHA256, memberIds: members.map((m: any) => m.id), to: 'First Exact Name', confirm: true })
    expect(first.status).toBe(200)
    if (packetState === 'missing') unlinkSync(f.paths.packet); else writeFileSync(f.paths.packet, 'CORRUPT AUTOMATIC PACKET')
    const named = (await f.panel()).body, action = named.intervalHumanAnnotation.activeActions[0]
    const human = named.intervalGroupScopes.find((s: any) => s.kind === 'human-words' && s.identityId === action.identityId)
    expect(human.members).toEqual(members); expect(human.displayLabel).toBe('First Exact Name')
    const path = `/speaker-interval-groups/${human.identityId}/relabel`, body = {
      recordId: f.recordId, expectedRevision: named.sourceRevision, scopeSHA256: human.scopeSHA256, memberIds: members.map((m: any) => m.id), to: 'Correct Exact Name' }
    const annotationBefore = readFileSync(f.paths.annotation, 'utf8')
    for (const flag of ['dryRun', 'confirm']) {
      expect((await f.request(path, { ...body, memberIds: [members[0].id], [flag]: true })).status).toBe(409)
      expect(readFileSync(f.paths.annotation, 'utf8')).toBe(annotationBefore)
    }
    const preview = await f.request(path, { ...body, memberIds: body.memberIds.slice().reverse(), dryRun: true })
    expect(preview.status).toBe(200); expect(preview.body.preview.members).toEqual(members)
    const renamed = await f.request(path, { ...body, confirm: true })
    expect(renamed.status).toBe(200); expect(renamed.body.correction).toMatchObject({ members: 2, fields: 2 })
    const current = (await f.panel()).body
    expect(current.intervalHumanAnnotation.activeActions.map((a: any) => a.actionId)).toEqual([renamed.body.correction.correctionId])
    expect(current.voices.some((v: any) => v.label === 'First Exact Name')).toBe(false)
    expect(current.voices.find((v: any) => v.label === 'Correct Exact Name')).toMatchObject({ nameAsserted: true, confirmedWordCount: 2 })
    expect((await f.content()).body.clipboardFull).toContain('[Correct Exact Name]:')
    expect((await f.request('/speaker-interval-groups/undo', undoBody(f, current, first.body.correction.correctionId))).status).toBe(409)
    const restored = await f.request('/speaker-interval-groups/undo', undoBody(f, current, renamed.body.correction.correctionId))
    expect(restored.status).toBe(200); expect(restored.body.correction.undone).toBe(true)
    const predecessor = (await f.panel()).body
    expect(predecessor.intervalHumanAnnotation.activeActions.map((a: any) => a.actionId)).toEqual([first.body.correction.correctionId])
    expect(predecessor.voices.find((v: any) => v.label === 'First Exact Name')).toMatchObject({ nameAsserted: true, confirmedWordCount: 2 })
    expect(predecessor.voices.some((v: any) => v.label === 'Correct Exact Name')).toBe(false)
    expect((await f.request('/speaker-interval-groups/undo', undoBody(f, predecessor, first.body.correction.correctionId))).status).toBe(200)
    const final = (await f.panel()).body
    expect(final.intervalHumanAnnotation.activeActions).toEqual([])
    expect(final.voices.some((v: any) => ['First Exact Name', 'Correct Exact Name'].includes(v.label))).toBe(false)
    f.assertImmutable()
  }, 30_000)

  it('requires explicit original-view confirmation and current source, refuses active actions, then archives the inactive epoch and preserves prior corrections', async () => {
    const f = await fixture(true), initial = (await f.panel()).body
    const originalPaths = originalViewPaths(f.files, f.sid), statePath = f.files.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-state.json')
    const automaticState = JSON.stringify({ fixture: 'generated automatic state', captureId: f.sid }); writeFileSync(statePath, automaticState)
    expect(initial.intervalOriginalViewAvailable).toBe(true)
    const named = await nameOne(f), active = (await f.panel()).body
    expect(active.intervalOriginalViewAvailable).toBe(false)
    expect((await f.request('/speaker-interval-groups/original', { recordId: f.recordId, expectedRevision: active.sourceRevision, confirm: true })).status).toBe(409)
    expect(existsSync(originalPaths.archiveRoot)).toBe(false)
    expect((await f.request('/speaker-interval-groups/undo', undoBody(f, active, named.saved.body.correction.correctionId))).status).toBe(200)
    const inactive = (await f.panel()).body
    expect(inactive.intervalOriginalViewAvailable).toBe(true)
    const body = { recordId: f.recordId, expectedRevision: inactive.sourceRevision, confirm: true }
    for (const invalid of [
      { recordId: f.recordId, expectedRevision: inactive.sourceRevision }, { ...body, confirm: false }, { ...body, confirm: 1 },
      { ...body, force: true }, { ...body, memberIds: [] }, { ...body, expectedRevision: 'bad' },
    ]) expect((await f.request('/speaker-interval-groups/original', invalid)).status).toBe(400)
    expect((await f.request('/speaker-interval-groups/original', { ...body, recordId: 'standalone:other' })).status).toBe(409)
    expect((await f.request('/speaker-interval-groups/original', { ...body, expectedRevision: initial.sourceRevision })).status).toBe(409)
    expect(existsSync(originalPaths.archiveRoot)).toBe(false)
    const annotation = readFileSync(f.paths.annotation, 'utf8'), journal = readFileSync(f.paths.journal, 'utf8')
    const exited = await f.request('/speaker-interval-groups/original', body)
    expect(exited.status).toBe(200); expect(exited.body).toMatchObject({ ok: true, confirmed: true, enrollmentAllowed: false })
    expect(exited.body.sourceRevision).not.toBe(inactive.sourceRevision)
    const receipt = inspectOriginalViewTransaction(f.files, f.sid)
    expect(receipt.status).toBe('complete')
    const archive = join(originalPaths.archiveRoot, receipt.archiveId!)
    expect(readFileSync(join(archive, 'packet.json'), 'utf8')).toBe(f.original.packet)
    expect(readFileSync(join(archive, 'state.json'), 'utf8')).toBe(automaticState)
    expect(readFileSync(join(archive, 'interval-human.json'), 'utf8')).toBe(annotation)
    expect(readFileSync(join(archive, 'interval-human-transaction.json'), 'utf8')).toBe(journal)
    for (const path of [f.paths.packet, f.paths.annotation, f.paths.journal, statePath]) expect(existsSync(path)).toBe(false)
    const final = (await f.panel()).body, content = (await f.content()).body
    expect(final.intervalGroupScopes).toBeUndefined(); expect(final.intervalHumanAnnotation).toBeUndefined(); expect(final.intervalOriginalViewAvailable).toBeUndefined()
    expect(final.effectiveSpeakerSummary).toBeUndefined()
    expect(final.voices.find((v: any) => v.label === 'Prior Human')).toMatchObject({ confirmedByHuman: true, nameAsserted: true })
    expect(final.groupScopes.some((s: any) => s.reviewBasis === 'human-authored')).toBe(true)
    expect(content.clipboardFull).toContain('[Prior Human]:')
    f.assertImmutable()
  }, 30_000)

  it('exposes interrupted original-view recovery and blocks legacy writes until the exact saved exit finishes', async () => {
    const f = await fixture(true), before = (await f.panel()).body, preview = previewOriginalViewTransaction(f.files, f.sid)
    expect(() => commitOriginalViewTransaction({ files: f.files, captureId: f.sid, expectedScopeSHA256: preview.scopeSHA256,
      afterWrite: index => { if (index === -1) throw Error('synthetic interrupted original view') } })).toThrow('synthetic interrupted original view')
    expect(inspectOriginalViewTransaction(f.files, f.sid)).toMatchObject({ status: 'prepared', archiveId: preview.archiveId })
    const transaction = originalViewPaths(f.files, f.sid), prepared = readFileSync(transaction.journal, 'utf8')
    const pending = (await f.panel()).body
    expect(pending.intervalHumanRecoveryRequired).toBe(true); expect(pending.intervalOriginalViewAvailable).toBe(false)
    expect(pending.intervalGroupScopes).toEqual([])
    expect(pending.voices.find((v: any) => v.label === 'Prior Human')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
    const legacy = f.priorLegacyScope
    for (const [path, body] of [
      ['/relabel', { recordId: f.recordId, expectedRevision: pending.sourceRevision, from: 'Voice 1', to: 'Other Person', dryRun: true }],
      [`/speaker-groups/${legacy.identityId}/relabel`, { recordId: f.recordId, expectedRevision: pending.sourceRevision, scopeSHA256: legacy.scopeSHA256,
        rawChunkIndices: [legacy.members[0].rawChunkIndex], to: 'Other Person', confirm: true }],
      ['/speaker-groups/recover', { recordId: f.recordId, confirm: true }],
      ['/speaker-interval-groups/original', { recordId: f.recordId, expectedRevision: before.sourceRevision, confirm: true }],
    ] as Array<[string, Record<string, unknown>]>) expect((await f.request(path, body)).status).toBe(409)
    expect(readFileSync(transaction.journal, 'utf8')).toBe(prepared)
    expect((await f.request('/speaker-interval-groups/recover', { recordId: f.recordId })).status).toBe(400)
    expect((await f.request('/speaker-interval-groups/recover', { recordId: 'standalone:other', confirm: true })).status).toBe(409)
    const recovered = await f.request('/speaker-interval-groups/recover', { recordId: f.recordId, confirm: true })
    expect(recovered.status).toBe(200); expect(recovered.body).toMatchObject({ ok: true, confirmed: true, enrollmentAllowed: false })
    expect(inspectOriginalViewTransaction(f.files, f.sid)).toMatchObject({ status: 'complete', archiveId: preview.archiveId })
    expect(existsSync(f.paths.packet)).toBe(false)
    const final = (await f.panel()).body
    expect(final.intervalGroupScopes).toBeUndefined(); expect(final.intervalHumanRecoveryRequired).toBeUndefined()
    expect(final.voices.find((v: any) => v.label === 'Prior Human')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
    f.assertImmutable()
  }, 30_000)


  it('offers an explicit exit for a state-only remnant and rejects state-only source drift before archiving', async () => {
    const f = await fixture(), statePath = f.files.sidecarPath.replace(/\.g2-chunks\.json$/, '.speaker-call-state.json')
    unlinkSync(f.paths.packet)
    const firstState = JSON.stringify({ captureId: f.sid, fixture: 'first generated state-only remnant' })
    const laterState = JSON.stringify({ captureId: f.sid, fixture: 'later generated state-only remnant' })
    writeFileSync(statePath, firstState)
    const before = (await f.panel()).body
    expect(before.intervalOriginalViewAvailable).toBe(true); expect(before.intervalGroupScopes).toEqual([])
    expect(before.intervalHumanAnnotation).toBeNull(); expect(before.intervalHumanRecoveryRequired).toBe(false)
    writeFileSync(statePath, laterState)
    const after = (await f.panel()).body
    expect(after.sourceRevision).not.toBe(before.sourceRevision)
    expect(after.intervalOriginalViewAvailable).toBe(true)
    const paths = originalViewPaths(f.files, f.sid)
    const refused = await f.request('/speaker-interval-groups/original', { recordId: f.recordId, expectedRevision: before.sourceRevision, confirm: true })
    expect(refused.status).toBe(409); expect(existsSync(paths.archiveRoot)).toBe(false)
    expect(readFileSync(statePath, 'utf8')).toBe(laterState)
    const exited = await f.request('/speaker-interval-groups/original', { recordId: f.recordId, expectedRevision: after.sourceRevision, confirm: true })
    expect(exited.status).toBe(200)
    const receipt = inspectOriginalViewTransaction(f.files, f.sid)
    expect(receipt.status).toBe('complete')
    expect(readFileSync(join(paths.archiveRoot, receipt.archiveId!, 'state.json'), 'utf8')).toBe(laterState)
    expect(existsSync(statePath)).toBe(false); expect(existsSync(f.paths.packet)).toBe(false)
    const original = (await f.panel()).body
    expect(original.intervalGroupScopes).toBeUndefined(); expect(original.intervalOriginalViewAvailable).toBeUndefined()
    f.assertImmutable()
  }, 30_000)

  it('offers an explicit exit for a corrupt automatic packet without human decisions and retains its exact archived bytes', async () => {
    const f = await fixture(), corrupt = 'GENERATED CORRUPT AUTOMATIC PACKET'
    writeFileSync(f.paths.packet, corrupt)
    const before = (await f.panel()).body
    expect(before.intervalOriginalViewAvailable).toBe(true); expect(before.intervalGroupScopes).toEqual([])
    expect(before.intervalHumanAnnotation).toBeNull(); expect(before.intervalHumanRecoveryRequired).toBe(false)
    const exited = await f.request('/speaker-interval-groups/original', { recordId: f.recordId, expectedRevision: before.sourceRevision, confirm: true })
    expect(exited.status).toBe(200); expect(exited.body).toMatchObject({ ok: true, confirmed: true, enrollmentAllowed: false })
    const paths = originalViewPaths(f.files, f.sid), receipt = inspectOriginalViewTransaction(f.files, f.sid)
    expect(receipt.status).toBe('complete')
    expect(readFileSync(join(paths.archiveRoot, receipt.archiveId!, 'packet.json'), 'utf8')).toBe(corrupt)
    expect(existsSync(f.paths.packet)).toBe(false)
    const original = (await f.panel()).body
    expect(original.intervalGroupScopes).toBeUndefined(); expect(original.intervalOriginalViewAvailable).toBeUndefined()
    f.assertImmutable()
  }, 30_000)

})
