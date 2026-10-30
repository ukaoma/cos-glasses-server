import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindMacSpeakerShadowRepair, type MacShadowRepairSource } from './mac-speaker-shadow-repair.js'
import { hashMacSpeakerLive, reconcileMacSpeaker256Snapshot, type MacSpeaker256SnapshotInput } from './mac-speaker-live-memory.js'
import { prepareMacSpeakerCallPacket, readMacSpeakerCallView, renderMacSpeakerCallMarkdown, resolveMacSpeakerCallView, type MacSpeakerCallPacket } from './mac-speaker-call-view.js'
import { SYNTHETIC_SPANS, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative } from './__fixtures__/speaker-shadow/synthetic-meeting.js'
import { dataPath } from './data-dir.js'
import { hashMacSpeakerDocument, hashMacSpeakerMachineBinding, projectMacSpeakerRepair } from './mac-speaker-repair-projection.js'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { reviewMeetingSpeakers } from './meeting-speaker-review.js'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const sealPacket = (p: MacSpeakerCallPacket) => { const { packetSHA256: _, ...body } = p; p.packetSHA256 = hash(JSON.stringify(body)); return p }
function sourceFixture(): MacShadowRepairSource {
  const chunkEntries: any[] = []
  for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
    const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
    const chunk = { text: `words for raw ${raw}`, speaker: span.label, elapsed: start * 1000, audioDurationMs: seconds * 1000, audioSha256: hash(`wav${raw}`), similarity: 0, segments: [{ speaker: span.label, startSec: 0, endSec: seconds }], finalSegments: [{ speaker: span.label, startSec: 0, endSec: seconds }], words: [{ word: `raw${raw}`, start: 0, end: seconds }] }
    chunkEntries.push({ chunkIndex: raw, chunk })
  }
  let offset = 0
  const speakerWords = chunkEntries.map(({ chunk }) => { const start = offset; offset += chunk.audioDurationMs / 1000; return { word: chunk.text, speaker: chunk.speaker, start, end: offset } })
  const doc = { sessionId: 'mac_call_view_test', sourceType: 'mac_system_audio', finalizationState: 'complete', batchApplied: true, chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, speakers: ['Dana Fictional'], batchSegments: [{ startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
  const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: hash(`pcm${e.chunkIndex}`), sampleCount: e.chunk.audioDurationMs * 16 }))
  return { originalJSON: JSON.stringify(doc), currentJSON: JSON.stringify(doc), ledgerJSONL: '', rawAudio, timeline: { rows: rawAudio.map((r, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: r.sampleCount, usedSampleCount: r.sampleCount })), total: SYNTHETIC_SECONDS * 16000, pcmSHA256: hash('timeline') }, cohort: { nativeJSON: JSON.stringify(syntheticNative()), embeddingsJSON: JSON.stringify(syntheticEmbeddings()), modelSHA256: hash('model'), cliSHA256: hash('cli') } }
}
function prepared(source = sourceFixture()) {
  const input: MacSpeaker256SnapshotInput = { ...source, sourceBindingSHA256: bindMacSpeakerShadowRepair(source), generation: 'capture-generation-test' }
  const state = reconcileMacSpeaker256Snapshot(null, input)
  const packet = prepareMacSpeakerCallPacket(input, state, { admission: 'qualified' })
  return { source, input, state, packet }
}
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('source-bound read-only call view', () => {
  it('consumes independently reconstructed recurrence state; preserves words, timing, real names, Ext and base bytes', () => {
    const { input, packet, state } = prepared(), before = input.currentJSON
    expect(state.groups.length).toBeGreaterThan(0)
    const view = resolveMacSpeakerCallView(before, '', packet)
    expect(view.metadata.status).toBe('applied')
    expect(view.metadata.changedChunks).toBeGreaterThan(0)
    expect(view.metadata.changedWords).toBeGreaterThan(0)
    const base = JSON.parse(before)
    expect(view.doc.speakers).toEqual(base.speakers)
    for (let i = 0; i < base.chunks.length; i++) {
      expect(view.doc.chunks[i].text).toBe(base.chunks[i].text)
      expect(view.doc.chunks[i].elapsed).toBe(base.chunks[i].elapsed)
      expect(view.doc.chunks[i].audioSha256).toBe(base.chunks[i].audioSha256)
      if (['Ext', 'Dana Fictional'].includes(base.chunks[i].speaker)) expect(view.doc.chunks[i]).toEqual(base.chunks[i])
    }
    expect(view.doc.batchSegments[0].speakerWords.map((w: any) => [w.word, w.start, w.end])).toEqual(base.batchSegments[0].speakerWords.map((w: any) => [w.word, w.start, w.end]))
    expect(input.currentJSON).toBe(before)
    expect(view.metadata.speakerPurityVerified).toBe(false)
  })
  it('default packet admission is off and aliases require explicit evaluation-only opt-in', () => {
    const { input, state, packet } = prepared()
    const off = prepareMacSpeakerCallPacket(input, state)
    expect(resolveMacSpeakerCallView(input.currentJSON, '', off).metadata.reason).toBe('packet-off')
    expect(resolveMacSpeakerCallView(input.currentJSON, '', packet, { mode: 'alias-evaluation' }).metadata.status).toBe('base')
    const alias = resolveMacSpeakerCallView(input.currentJSON, '', off, { mode: 'alias-evaluation', allowEvaluation: true })
    expect(alias.metadata.status).toBe('applied')
    expect(alias.doc.chunks.every((c: any) => !c.speaker.startsWith('Unidentified'))).toBe(true)
  })
  it('uses retained identity ordinals rather than group order for anonymous display labels', () => {
    const { input, packet, state } = prepared()
    expect(state.groups.length).toBeGreaterThan(1)
    state.groups.reverse()
    const { stateSHA256: _, ...body } = state; state.stateSHA256 = hashMacSpeakerLive(body)
    expect(prepareMacSpeakerCallPacket(input, state).displayLabels).toEqual(packet.displayLabels)
    for (const g of state.groups) expect(packet.displayLabels[g.identityId]).toBe(state.identities.find(i => i.identityId === g.identityId)!.birthIntervals[0].originalVoice)
    const { generation: _generation, expectedStateSHA256: _e, sourceBindingSHA256: _s, ...source } = input
    const native = JSON.parse(source.cohort.nativeJSON)
    native.segments = native.segments.filter((s: any) => s.speakerId !== state.groups.at(-1)!.nativeCluster)
    source.cohort = { ...source.cohort, nativeJSON: JSON.stringify(native) }
    const nextInput = { ...source, generation: input.generation, expectedStateSHA256: state.stateSHA256, sourceBindingSHA256: bindMacSpeakerShadowRepair(source) }
    const nextState = reconcileMacSpeaker256Snapshot(state, nextInput), next = prepareMacSpeakerCallPacket(nextInput, nextState)
    expect(nextState.groups.length).toBeLessThan(state.groups.length)
    for (const g of nextState.groups) expect(next.displayLabels[g.identityId]).toBe(packet.displayLabels[g.identityId])
  })
  it('composes a prior qualified named repair on immutable BASE; validating the derived view cannot erase that base proof', () => {
    const source = sourceFixture(), original = JSON.parse(source.originalJSON), starts = [0, 11]
    const counts = Object.fromEntries(source.rawAudio.map(a => [a.rawChunkIndex, a.sampleCount]))
    const windows = starts.map((start, i) => ({ id: `priorwindow${i}`, captureStartSample: original.chunkEntries[start].chunk.elapsed * 16, captureEndSample: original.chunkEntries[start].chunk.elapsed * 16 + 480000, pcmSha256: String(i + 1).repeat(64), similarity: .95, runnerUpSimilarity: .1, rawChunks: Array.from({ length: 5 }, (_, j) => ({ rawChunkIndex: start + j, audioSha256: source.rawAudio[start + j].wavSHA256, sampleCount: 96000 })) }))
    const proof = { kind: 'profile-match' as const, profileName: 'Jeremy Example', profileSha256: 'c'.repeat(64), modelSha256: 'd'.repeat(64), algorithmVersion: 'synthetic-prior-proof', crossWindowCosines: [[1, .95], [.95, 1]], windows }
    const assignments = starts.flatMap(start => Array.from({ length: 5 }, (_, j) => start + j)).map(raw => { const w = original.batchSegments[0].speakerWords[raw]; return { rawChunkIndex: raw, from: original.chunks[raw].speaker, to: 'Jeremy Example', evidenceId: 'prior_named', targetEvidence: proof, batchWords: [{ segmentIndex: 0, wordIndex: raw, from: w.speaker, word: w.word, start: w.start, end: w.end }] } })
    const prior = projectMacSpeakerRepair(original, { id: 'prior_named', evidenceHash: hash('evidence'), expectedDocumentHash: hashMacSpeakerDocument(original), protectedRawChunkIndices: [], rawAudioSampleCounts: counts, assignments })
    const named = prior.doc
    named.correctionRevision = 1
    named.speakerRepair = { id: 'prior_named', evidenceHash: hash('evidence'), machineEvidence: { version: 1, correctionRevision: 1, documentBinding: hashMacSpeakerMachineBinding(named), receipt: prior.receipt, rawAudioSampleCounts: counts } }
    source.currentJSON = JSON.stringify(named)
    expect(readMacSpeakerMachineEvidence(named).status).toBe('qualified')
    const { input, packet } = prepared(source), view = resolveMacSpeakerCallView(input.currentJSON, '', packet)
    expect(view.metadata.status).toBe('applied')
    expect(view.doc.speakerRepair).toEqual(named.speakerRepair)
    for (const [i, c] of named.chunks.entries()) if (c.speaker === 'Jeremy Example') expect(view.doc.chunks[i]).toEqual(c)
    expect(readMacSpeakerMachineEvidence(JSON.parse(input.currentJSON)).status).toBe('qualified')
    const drift = JSON.parse(input.currentJSON); drift.speakerRepair.machineEvidence.documentBinding = hash('wrong')
    const changed = sourceFixture(); changed.currentJSON = JSON.stringify(drift)
    const invalid = prepared(changed)
    expect(resolveMacSpeakerCallView(invalid.input.currentJSON, '', invalid.packet).metadata.reason).toBe('base-machine-proof-invalid')
  })
  it('withdraws on current root-only human edit, full ledger drift, generation/hash tampering and corrupt interval geometry', () => {
    const { input, packet } = prepared(), changed = JSON.parse(input.currentJSON)
    changed.chunks[0].speaker = 'Human Correction'
    for (const [base, ledger, p] of [[JSON.stringify(changed), '', packet], [input.currentJSON, '{"phase":"confirmed","chunks":[]}', packet], [input.currentJSON, '', { ...packet, generation: 'different' }], [input.currentJSON, '', sealPacket({ ...structuredClone(packet), groups: packet.groups.map((g, i) => i ? g : { ...g, intervals: [{ ...g.intervals[0], endSample: Number.MAX_SAFE_INTEGER }] }) })]] as const) expect(resolveMacSpeakerCallView(base, ledger, p).metadata.status).toBe('base')
  })
  it('keeps named/manual rows and empty global confirmation protected in both modes', () => {
    const source = sourceFixture(), d = JSON.parse(source.currentJSON), position = d.chunks.findIndex((c: any) => c.speaker === 'Voice 2')
    d.chunks[position].manuallyCorrected = true
    source.currentJSON = JSON.stringify(d)
    const { input, packet } = prepared(source)
    for (const mode of ['strict', 'alias-evaluation'] as const) expect(resolveMacSpeakerCallView(input.currentJSON, '', packet, { mode, allowEvaluation: true }).doc.chunks[position]).toEqual(d.chunks[position])
    source.ledgerJSONL = JSON.stringify({ id: 'confirmation', phase: 'confirmed', from: '', to: '', chunks: [] })
    const confirmed = prepared(source)
    expect(confirmed.packet.groups).toEqual([])
    expect(resolveMacSpeakerCallView(confirmed.input.currentJSON, source.ledgerJSONL, confirmed.packet).doc).toEqual(d)
  })
  it('withdraws turn projection when a retained birth Voice is now fully human-named instead of reintroducing its old label', () => {
    const first = prepared(), initial = first.state.groups[0], hint = first.packet.displayLabels[initial.identityId]
    const { generation: _g, expectedStateSHA256: _e, sourceBindingSHA256: _s, ...source } = first.input
    const current = JSON.parse(source.currentJSON)
    for (const c of [...current.chunks, ...current.chunkEntries.map((e: any) => e.chunk)]) if (c.speaker === hint) { c.speaker = 'Human Name'; for (const key of ['segments', 'finalSegments', 'words']) for (const r of c[key] ?? []) if (r.speaker === hint) r.speaker = 'Human Name' }
    for (const w of current.batchSegments[0].speakerWords) if (w.speaker === hint) w.speaker = 'Human Name'
    source.currentJSON = JSON.stringify(current)
    const input = { ...source, generation: first.input.generation, expectedStateSHA256: first.state.stateSHA256, sourceBindingSHA256: bindMacSpeakerShadowRepair(source) }
    const state = reconcileMacSpeaker256Snapshot(first.state, input), packet = prepareMacSpeakerCallPacket(input, state, { admission: 'qualified' })
    const view = resolveMacSpeakerCallView(input.currentJSON, '', packet)
    expect(view.metadata.status).toBe('applied')
    expect(view.doc.chunks.some((c: any) => c.speaker === hint)).toBe(false)
    for (const [i, c] of current.chunks.entries()) if ((c as any).speaker === 'Human Name') expect(view.doc.chunks[i]).toEqual(c)
    expect(state.groups.find(g => g.identityId === initial.identityId)).toBeDefined()
  })
  it('does not fill a native gap or change words crossing it; aliases expose the competing hypothesis only when explicitly requested', () => {
    const { input, packet } = prepared(), narrow = structuredClone(packet)
    const group = narrow.groups[0], interval = group.intervals[0]
    group.intervals = [{ ...interval, startSample: interval.startSample + 16000 }]
    sealPacket(narrow)
    const strict = resolveMacSpeakerCallView(input.currentJSON, '', narrow)
    const base = JSON.parse(input.currentJSON), index = base.chunkEntries.slice(0, interval.rawChunkIndex).filter((e: any) => e.chunk.text.trim()).length
    expect(strict.doc.chunks[index]).toEqual(base.chunks[index])
    expect(strict.doc.batchSegments[0].speakerWords[index]).toEqual(base.batchSegments[0].speakerWords[index])
    expect(strict.metadata.groups[0].intervals[0].startSample).toBe(interval.startSample + 16000)
  })
  it('refuses a root relabel when another stored word/final-segment clock extends outside native support', () => {
    const source = sourceFixture(), doc = JSON.parse(source.currentJSON)
    const raw = doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 1' && e.chunk.audioDurationMs === 6000)
    for (const key of ['originalJSON', 'currentJSON'] as const) { const d = JSON.parse(source[key]); for (const c of [d.chunks[raw], d.chunkEntries[raw].chunk]) c.segments = [{ speaker: c.speaker, startSec: 1, endSec: 2 }]; source[key] = JSON.stringify(d) }
    const { input, packet } = prepared(source), view = resolveMacSpeakerCallView(input.currentJSON, '', packet)
    expect(packet.groups.some(g => g.intervals.some(i => i.rawChunkIndex === raw))).toBe(true)
    expect(view.doc.chunks[raw]).toEqual(JSON.parse(input.currentJSON).chunks[raw])
    expect(view.doc.chunkEntries[raw]).toEqual(JSON.parse(input.currentJSON).chunkEntries[raw])
  })
  it('enumerates a supported word-only identity in review without fabricating chunks or named claims; rejects evidence-only ghost labels', () => {
    const source = sourceFixture()
    for (const key of ['originalJSON', 'currentJSON'] as const) { const d = JSON.parse(source[key]); for (const w of d.batchSegments[0].speakerWords) if (w.end - w.start > 2) { w.start += 1; w.end -= 1 }; source[key] = JSON.stringify(d) }
    const { input, packet } = prepared(source)
    for (const g of packet.groups) g.intervals = g.intervals.filter(s => s.endSample - s.startSample > 16000).map(s => ({ ...s, startSample: s.startSample + 8000, endSample: s.endSample - 8000 }))
    sealPacket(packet)
    const view = resolveMacSpeakerCallView(input.currentJSON, '', packet), base = JSON.parse(input.currentJSON)
    expect(view.metadata.changedChunks).toBe(0); expect(view.metadata.changedWords).toBeGreaterThan(0)
    const review = reviewMeetingSpeakers(view.doc.chunks, { batchSegments: view.doc.batchSegments, callViewAnonymousLabels: [...view.metadata.groups.map(g => g.label), 'Unidentified 999', 'Forged Name'] })
    expect(review.voices.some(v => view.metadata.groups.some(g => g.label === v.label) && v.speakingMs > 0 && !v.nameAsserted)).toBe(true)
    expect(review.voices.some(v => ['Unidentified 999', 'Forged Name'].includes(v.label))).toBe(false)
    expect(view.doc.chunks).toEqual(base.chunks)
  })
  it('uses raw PCM clock including a silent original rather than compacted transcript positions', () => {
    const source = sourceFixture()
    for (const key of ['originalJSON', 'currentJSON'] as const) { const d = JSON.parse(source[key]); d.chunkEntries[0].chunk.text = ''; d.chunks.shift(); d.batchSegments[0].speakerWords.shift(); source[key] = JSON.stringify(d) }
    const { input, packet } = prepared(source), view = resolveMacSpeakerCallView(input.currentJSON, '', packet)
    const base = JSON.parse(input.currentJSON)
    expect(base.batchSegments[0].speakerWords[0].start).toBe(6)
    expect(view.doc.batchSegments[0].speakerWords[0].start).toBe(6)
    expect(view.metadata.status).toBe('applied')
    expect(view.doc.batchSegments[0].speakerWords[0].speaker).toBe(packet.groups.find(g => g.memberVoices.includes('Voice 1'))?.keepVoiceHint ?? 'Voice 1')
    expect(view.doc.chunkEntries[0]).toEqual(base.chunkEntries[0])
  })
  it('renders labels through exact canonical words while preserving transcript token bytes and refuses an unbound transcript', () => {
    const { input, packet } = prepared(), base = JSON.parse(input.currentJSON), view = resolveMacSpeakerCallView(input.currentJSON, '', packet)
    const markdown = '# Test\n\n## Transcript\n' + base.batchSegments[0].speakerWords.map((w: any) => `[${w.speaker}]: ${w.word}`).join('\n')
    const rendered = renderMacSpeakerCallMarkdown(markdown, base, view)
    expect(rendered).not.toBe(markdown)
    expect(rendered.replace(/\[[^\]]+\]:/g, '[speaker]:')).toBe(markdown.replace(/\[[^\]]+\]:/g, '[speaker]:'))
    const changed = base.batchSegments[0].speakerWords.find((w: any, i: number) => w.speaker !== view.doc.batchSegments[0].speakerWords[i].speaker)
    expect(() => renderMacSpeakerCallMarkdown(markdown.replace(changed.word, 'changed words'), base, view)).toThrow()
  })
  it('loader accepts qualified strict packets only, preserves all stored files, and withdraws stale snapshot after ledger append', () => {
    const { input, packet } = prepared(), root = mkdtempSync(join(realpathSync(tmpdir()), 'call-view-')); roots.push(root)
    const path = join(root, 'record.g2-chunks.json'), packetPath = join(root, 'record.speaker-call.json')
    writeFileSync(path, input.currentJSON); writeFileSync(packetPath, JSON.stringify(packet))
    expect(readMacSpeakerCallView(path, input.currentJSON).metadata.status).toBe('applied')
    expect(readFileSync(path, 'utf8')).toBe(input.currentJSON)
    const ledgerDir = dataPath('meeting-corrections'); mkdirSync(ledgerDir, { recursive: true })
    const ledger = join(ledgerDir, 'mac_call_view_test.jsonl')
    try { writeFileSync(ledger, '{"human":"new correction"}\n'); expect(readMacSpeakerCallView(path, input.currentJSON).metadata.status).toBe('base') } finally { rmSync(ledger, { force: true }) }
    writeFileSync(packetPath, JSON.stringify({ ...packet, admission: 'off' }))
    expect(readMacSpeakerCallView(path, input.currentJSON).metadata.status).toBe('base')
  })
  it('actual meeting panel and copy endpoint consume the same strict view while canonical evidence stays unchanged', async () => {
    const { default: express } = await import('express')
    const { createMeetingRouter } = await import('../routes/meeting.js')
    const { input, packet } = prepared(), root = mkdtempSync(join(realpathSync(tmpdir()), 'call-view-http-')); roots.push(root)
    const sidecarPath = join(root, 'record.g2-chunks.json'), filepath = join(root, 'record.md'), base = JSON.parse(input.currentJSON)
    const markdown = '# Call View\n\n## Transcript\n' + base.batchSegments[0].speakerWords.map((w: any) => `[${w.speaker}]: ${w.word}`).join('\n')
    writeFileSync(sidecarPath, input.currentJSON); writeFileSync(filepath, markdown); writeFileSync(join(root, 'record.speaker-call.json'), JSON.stringify(packet))
    const previousOps = process.env.COS_OPERATIONS_DIR, previousMeetings = process.env.COS_MEETINGS_ROOT
    delete process.env.COS_OPERATIONS_DIR; delete process.env.COS_MEETINGS_ROOT
    const app = express(); app.use('/api', createMeetingRouter({ store: { findBySessionId: () => ({ sidecarPath, filepath, title: 'Call View', domain: 'personal', filename: 'record.md', durationMin: 6 }) } as any }))
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
    try {
      const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}/api/meeting/${base.sessionId}`
      const panelResponse = await fetch(`${origin}/speakers`), contentResponse = await fetch(`${origin}/content`)
      expect(panelResponse.status).toBe(200); expect(contentResponse.status).toBe(200)
      const panel = await panelResponse.json(), content = await contentResponse.json()
      expect(panel.speakerCallView.status).toBe('applied'); expect(content.speakerCallView.packetSHA256).toBe(panel.speakerCallView.packetSHA256)
      expect(JSON.stringify(content)).toContain('source-bound-anonymous-view')
      expect(readFileSync(sidecarPath, 'utf8')).toBe(input.currentJSON); expect(readFileSync(filepath, 'utf8')).toBe(markdown)
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); if (previousOps === undefined) delete process.env.COS_OPERATIONS_DIR; else process.env.COS_OPERATIONS_DIR = previousOps; if (previousMeetings === undefined) delete process.env.COS_MEETINGS_ROOT; else process.env.COS_MEETINGS_ROOT = previousMeetings }
  })
})
