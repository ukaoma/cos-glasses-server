import express from 'express'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNTHETIC_SPANS, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative } from '../lib/__fixtures__/speaker-shadow/synthetic-meeting.js'
import { bindMacSpeakerShadowRepair, type MacShadowRepairSource } from '../lib/mac-speaker-shadow-repair.js'
import { reconcileMacSpeaker256Snapshot } from '../lib/mac-speaker-live-memory.js'
import { prepareMacSpeakerCallPacket, readMacSpeakerCallView } from '../lib/mac-speaker-call-view.js'
import { macCallHumanPaths } from '../lib/mac-speaker-call-human.js'
import { MeetingStore } from '../lib/meeting-store.js'
import { createMeetingRouter, fileFinishedMacRecording } from './meeting.js'

const control = vi.hoisted(() => ({ availability: vi.fn(), changed: vi.fn() }))
vi.mock('../lib/mac-speaker-call-producer.js', async original => ({
  ...await original<typeof import('../lib/mac-speaker-call-producer.js')>(),
  macSpeakerCallCachedRefreshAvailability: control.availability,
  notifyMacSpeakerCallLedgerChanged: control.changed,
}))
await vi.hoisted(async () => { const { realpathSync } = await import('node:fs'); process.env.COS_DATA_DIR = realpathSync(process.env.COS_DATA_DIR!) })
const sha = (b: string) => createHash('sha256').update(b).digest('hex')
const roots: string[] = [], ledgerPaths: string[] = [], servers: Server[] = []
beforeEach(() => { control.availability.mockReset().mockResolvedValue({ available: true, reason: 'synthetic-test-only' }); control.changed.mockReset() })
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(done => s.close(() => done())) }; for (const p of ledgerPaths.splice(0)) rmSync(p, { force: true }); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'call-api-'))); roots.push(root)
  const sid = 'mac_00000000-0000-4000-8000-0000000000dc', chunkEntries: any[] = []
  for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
    const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
    const chunk = { text: `words for raw ${raw}`, speaker: span.label, elapsed: start * 1000, audioDurationMs: seconds * 1000, audioSha256: sha(`wav${raw}`), similarity: 0, segments: [{ speaker: span.label, startSec: 0, endSec: seconds }], finalSegments: [{ speaker: span.label, startSec: 0, endSec: seconds }], words: [{ word: `raw${raw}`, speaker: span.label, start: 0, end: seconds }] }
    chunkEntries.push({ chunkIndex: raw, chunk })
  }
  let offset = 0
  const speakerWords = chunkEntries.map(({ chunk }) => { const start = offset; offset += chunk.audioDurationMs / 1000; return { word: chunk.text, speaker: chunk.speaker, start, end: offset } })
  const doc = { sessionId: sid, sourceType: 'mac_system_audio', finalizationState: 'complete', batchApplied: true, chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, speakers: ['Dana Fictional'], batchSegments: [{ startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
  const store = new MeetingStore(join(root, 'recordings'))
  const markdown = '# Synthetic call\n\n| **Date** | 2026-10-29 |\n| **Source** | Mac System Audio |\n\n## Transcript\n' + speakerWords.map(w => `[${w.speaker}]: ${w.word}`).join('\n')
  const month = join(root, 'recordings', '2026-10'); mkdirSync(month, { recursive: true })
  const files = { sidecarPath: join(month, '2026-10-29_Synthetic_call.g2-chunks.json'), meetingPath: join(month, '2026-10-29_Synthetic_call.md') }
  const paths = macCallHumanPaths(files, sid); ledgerPaths.push(paths.ledger); mkdirSync(dirname(paths.ledger), { recursive: true })
  writeFileSync(files.sidecarPath, JSON.stringify(doc)); writeFileSync(files.meetingPath, markdown)
  const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: sha(`pcm${e.chunkIndex}`), sampleCount: e.chunk.audioDurationMs * 16 }))
  const source: MacShadowRepairSource = { originalJSON: JSON.stringify(doc), currentJSON: JSON.stringify(doc), ledgerJSONL: '', rawAudio, timeline: { rows: rawAudio.map((r, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: r.sampleCount, usedSampleCount: r.sampleCount })), total: SYNTHETIC_SECONDS * 16000, pcmSHA256: sha('timeline') }, cohort: { nativeJSON: JSON.stringify(syntheticNative()), embeddingsJSON: JSON.stringify(syntheticEmbeddings()), modelSHA256: sha('model'), cliSHA256: sha('cli') } }
  let state: ReturnType<typeof reconcileMacSpeaker256Snapshot> | null = null
  const refresh = () => {
    const s = { ...source, ledgerJSONL: existsSync(paths.ledger) ? readFileSync(paths.ledger, 'utf8') : '' }
    const input = { ...s, generation: 'synthetic-api-generation', sourceBindingSHA256: bindMacSpeakerShadowRepair(s), ...(state ? { expectedStateSHA256: state.stateSHA256 } : {}) }
    state = reconcileMacSpeaker256Snapshot(state, input)
    writeFileSync(paths.packet, JSON.stringify(prepareMacSpeakerCallPacket(input, state, { admission: 'qualified', projectionPolicy: 'anonymous-estimate' })))
  }
  refresh()
  const app = express(); app.use((req, res, next) => req.headers['x-cos-token'] === 'synthetic-only' ? next() : res.status(401).json({ reason: 'unauthorized' })); app.use(express.json()); app.use('/api', createMeetingRouter({ store }))
  const server = await new Promise<Server>(done => { const s = app.listen(0, '127.0.0.1', () => done(s)) }); servers.push(server)
  const address = server.address(); if (!address || typeof address === 'string') throw Error('socket')
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/meeting/${sid}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-cos-token': 'synthetic-only', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as any }
  }
  const groups = () => request('/speaker-groups')
  const selection = (g: any, scope: any, to = 'Human Example') => ({ recordId: g.recordId, expectedRevision: g.sourceRevision, scopeSHA256: scope.scopeSHA256, rawChunkIndices: [scope.members[0].rawChunkIndex], to })
  return { sid, files, paths, markdown, source, request, groups, selection, refresh, root }
}

describe('authenticated call-wide group correction handoff', () => {
  it('previews without native capability but refuses a first confirmation before any writes when cached refresh is unavailable', async () => {
    const f = await fixture(), g = (await f.groups()).body, scope = g.groupScopes[0], selected = f.selection(g, scope)
    control.availability.mockResolvedValue({ available: false, reason: 'producer_disabled' })
    expect((await f.request(`/speaker-groups/${scope.identityId}/relabel`, { ...selected, dryRun: true })).status).toBe(200)
    expect(control.availability).not.toHaveBeenCalled()
    const result = await f.request(`/speaker-groups/${scope.identityId}/relabel`, { ...selected, confirm: true })
    expect(result).toMatchObject({ status: 409, body: { reason: 'group_refresh_unavailable' } })
    expect(existsSync(f.paths.ledger)).toBe(false); expect(existsSync(f.paths.annotation)).toBe(false); expect(control.changed).not.toHaveBeenCalled()
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.source.currentJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.markdown)
  })
  it('can name two different groups after a cached refresh, preserving the first correction and immutable sources', async () => {
    const f = await fixture(), first = (await f.groups()).body, a = first.groupScopes[0], selectedA = f.selection(first, a)
    expect((await f.request(`/speaker-groups/${a.identityId}/relabel`, { ...selectedA, confirm: true })).status).toBe(200)
    expect(control.changed).toHaveBeenCalledWith(f.sid)
    f.refresh()
    const next = (await f.groups()).body, b = next.groupScopes.find((s: any) => s.reviewBasis !== 'human-authored' && s.members.every((m: any) => m.rawChunkIndex !== selectedA.rawChunkIndices[0]))
    expect(b).toBeDefined()
    const selectedB = f.selection(next, b, 'Other Human')
    expect((await f.request(`/speaker-groups/${b.identityId}/relabel`, { ...selectedB, confirm: true })).status).toBe(200)
    const view = readMacSpeakerCallView(f.files.sidecarPath, f.source.currentJSON, f.files.meetingPath)
    expect(view.doc.chunks[a.members[0].position].speaker).toBe('Human Example'); expect(view.doc.chunks[b.members[0].position].speaker).toBe('Other Human')
    expect(control.changed).toHaveBeenCalledTimes(2)
    control.availability.mockResolvedValue({ available: false, reason: 'producer_disabled' })
    const third = (await f.groups()).body, human = third.groupScopes.find((s: any) => s.displayLabel === 'Human Example')
    expect(human).toBeDefined(); expect((await f.request(`/speaker-groups/${human.identityId}/relabel`, { ...f.selection(third, human, 'Corrected Human'), confirm: true })).status).toBe(200)
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.source.currentJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.markdown)
  })
  it('revalidates the source after asynchronous refresh admission', async () => {
    const f = await fixture(), g = (await f.groups()).body, scope = g.groupScopes[0]
    control.availability.mockImplementation(async () => { writeFileSync(f.files.sidecarPath, f.source.currentJSON + '\n'); return { available: true, reason: 'synthetic' } })
    expect((await f.request(`/speaker-groups/${scope.identityId}/relabel`, { ...f.selection(g, scope), confirm: true })).status).toBe(409)
    expect(existsSync(f.paths.ledger)).toBe(false); expect(existsSync(f.paths.annotation)).toBe(false); expect(control.changed).not.toHaveBeenCalled()
  })
  for (const to of ['Ext', 'Unknown', 'MU', 'Unidentified', 'Speaker 2']) it(`refuses placeholder ${to} at the API boundary`, async () => {
    const f = await fixture(), g = (await f.groups()).body, scope = g.groupScopes[0]
    expect((await f.request(`/speaker-groups/${scope.identityId}/relabel`, { ...f.selection(g, scope, to), confirm: true })).status).toBe(400)
    expect(control.availability).not.toHaveBeenCalled(); expect(existsSync(f.paths.ledger)).toBe(false)
  })
})

describe('saved Mac call producer lifecycle', () => {
  it('registers the standalone consumer before the log-only consumer even when filing is unavailable', async () => {
    const order: string[] = [], sid = 'mac_00000000-0000-4000-8000-0000000000dd'
    await fileFinishedMacRecording(sid, '/unused/test.md', 'test', { configured: () => false, notify: async () => { order.push('producer') }, shadowNotify: () => { order.push('shadow') } })
    expect(order).toEqual(['producer', 'shadow'])
  })
  it('registers only the exact filed Mac copy and original; wrong capture copies are excluded', async () => {
    const f = await fixture(), calls: string[] = []
    const deps = { configured: () => true, file: async () => ({ outcome: 'filed' as const, path: f.files.meetingPath, status: 'enriched' }), operationsRoot: () => f.root, notify: async (input: { sidecarPath: string }) => { calls.push(input.sidecarPath) }, shadowNotify: () => {} }
    await fileFinishedMacRecording(f.sid, join(f.root, 'standalone.md'), 'test', deps)
    expect(calls).toEqual([f.files.sidecarPath, join(f.root, 'standalone.g2-chunks.json')])
    calls.splice(0); const doc = JSON.parse(f.source.currentJSON); doc.sessionId = 'mac_wrong'; writeFileSync(f.files.sidecarPath, JSON.stringify(doc))
    await fileFinishedMacRecording(f.sid, join(f.root, 'standalone.md'), 'test', deps)
    expect(calls).toEqual([join(f.root, 'standalone.g2-chunks.json')])
  })
})
