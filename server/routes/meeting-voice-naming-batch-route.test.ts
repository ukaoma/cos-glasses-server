// The batch naming routes over real HTTP: a real express app, the real token gate, a real store and profile store on
// disk, the real suggestion runner, and the real POST /relabel as the person who changes a label afterwards. Only the
// extractor and the sherpa runtime are fake. The revision is this file's own hash, because the router's is a closure
// inside createMeetingRouter. Every name and word is invented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fakeSpeakerRuntime } from '../lib/__fixtures__/fake-speaker-runtime.js'

const SESSION = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
const TOKEN = 'test-token-not-a-secret'
const STEM = '2026-10-28_Invented_Review_abc12345'
const DIM = 192
const LABELS: Array<[string, number]> = [['Voice 1', 0], ['Voice 2', 1], ['Voice 3', 2]]
const CHUNKS_PER_VOICE = 4

let home = ''
let server: Server | null = null
let baseUrl = ''
const data = (...parts: string[]) => join(home, 'data', ...parts)
const meetingDir = () => join(home, 'meetings', '2026-10')
const sidecarPath = () => join(meetingDir(), `${STEM}.g2-chunks.json`)
const meetingPath = () => join(meetingDir(), `${STEM}.md`)
const revision = () => createHash('sha256').update(readFileSync(meetingPath())).update(readFileSync(sidecarPath())).digest('hex')
const speakers = (): string[] => JSON.parse(readFileSync(sidecarPath(), 'utf-8')).chunks.map((c: { speaker: string }) => c.speaker)
const store = (): Array<{ name: string; embeddings: number[][]; sources: string[] }> => JSON.parse(readFileSync(data('voice-profiles.json'), 'utf-8')).profiles

function voiceprint(marker: number, axis: number): Float32Array {
  const v = new Float32Array(DIM)
  for (let k = axis; k < 120; k += 5) v[k] = 100
  v[120 + (marker % 63)] = 170
  v[DIM - 1] = marker
  return v
}
function wav(code: number): Buffer {
  const samples = 3 * 16_000
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16_000, 24); b.writeUInt32LE(32_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  for (let at = 44; at < b.length; at += 2) b.writeInt16LE(code, at)
  return b
}
const extract = (audio: Buffer): Float32Array => { const code = audio.readInt16LE(44); return voiceprint(code % 100, Math.floor(code / 100) - 1) }

function seed(): void {
  mkdirSync(meetingDir(), { recursive: true })
  mkdirSync(data('meeting-audio', SESSION), { recursive: true })
  const chunks: unknown[] = []
  const chunkEntries: unknown[] = []
  const turns: string[] = []
  let raw = 0
  for (const [label, axis] of LABELS) {
    for (let i = 0; i < CHUNKS_PER_VOICE; i++) {
      const chunk = { speaker: label, elapsed: raw * 3000, similarity: 0.4, text: `invented remark ${raw}`, segments: [{ speaker: label, startSec: 0, endSec: 3, text: `invented remark ${raw}`, similarity: 0.4 }] }
      chunks.push(chunk)
      chunkEntries.push({ chunkIndex: raw, chunk })
      turns.push(`[${label}]: invented remark ${raw}`)
      writeFileSync(data('meeting-audio', SESSION, `chunk_${String(raw).padStart(4, '0')}.wav`), wav((axis + 1) * 100 + raw + 1))
      raw++
    }
  }
  writeFileSync(sidecarPath(), `${JSON.stringify({ schemaVersion: 2, sessionId: SESSION, sourceType: 'mac_system_audio', startTime: 1_790_000_000_000, durationMs: raw * 3000, finalizationState: 'complete', speakers: [], chunks, chunkEntries }, null, 2)}\n`)
  writeFileSync(meetingPath(), `# Invented review\n\n| **Date** | 2026-10-28 |\n\n## Summary\n\nInvented.\n\n## Transcript\n\n${turns.join('\n')}\n`)
  const person = (name: string, axis: number) => ({ name, embeddings: Array.from({ length: 12 }, (_, i) => Array.from(voiceprint(30 + i, axis))), sources: Array(12).fill('g2-training') })
  writeFileSync(data('voice-profiles.json'), JSON.stringify({ profiles: [person('Dana Reyes', 0), person('Theo Marsh', 1), person('Ivo Lund', 3)] }))
}

async function start(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU', getOwnerName: () => 'Miles', getVocabulary: () => [], getTranscriptionProfileStatus: () => ({}) }))
  vi.doMock('../lib/speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/speaker-embeddings.js')
    ;(actual.__installSpeakerRuntimeForTests as (r: unknown) => void)(fakeSpeakerRuntime())
    return { ...actual, isEmbeddingAvailable: () => true, extractEmbedding: extract }
  })
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const { registerMacVoiceNamingBatchRoutes } = await import('../lib/mac-voice-naming-batch.js')
  const { requireApiToken } = await import('../lib/api-auth.js')
  const meetingStore = new MeetingStore(join(home, 'meetings'))
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use(express.json())
  const router = express.Router()
  registerMacVoiceNamingBatchRoutes(router, { store: meetingStore, captureActive: () => false, reviewRevision: revision, callViewMutationRefusal: () => null, finalizingRefusal: () => null, acquireLock: async () => ({ release: () => {} }) })
  app.use('/api', router)
  app.use('/api', createMeetingRouter({ store: meetingStore, captureActive: () => false }))
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

/** Runs the real job, as a click on Suggest names does. */
async function suggestNames(scopes: string[][]): Promise<void> {
  const { VoiceSuggestionRunner, resetVoiceSuggestionRunnerForTests, currentVoiceSuggestions, voiceSidecarEntries } = await import('../lib/mac-voice-suggestions.js')
  const { readVoiceProfiles } = await import('../lib/speaker-embeddings.js')
  const runner = new VoiceSuggestionRunner({ available: () => true, extract, readProfiles: readVoiceProfiles, ownerLabel: () => 'MU', log: () => {} })
  resetVoiceSuggestionRunnerForTests(runner)
  runner.start({ sessionId: SESSION, sourceRevision: revision(), entries: voiceSidecarEntries(JSON.parse(readFileSync(sidecarPath(), 'utf-8'))) ?? [], loadScopes: async () => scopes, block: () => null, pause: () => false })
  await vi.waitFor(() => { expect(currentVoiceSuggestions(SESSION)).not.toBeNull() }, { timeout: 5000, interval: 5 })
}

const send = async (path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Cos-Token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() }
}
const BATCH = `/meeting/${SESSION}/voice-naming-batch`
const ITEMS = [{ labels: ['Voice 1'], name: 'Dana Reyes' }, { labels: ['Voice 2'], name: 'Theo Marsh' }]

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cos-naming-route-'))
  mkdirSync(join(home, 'data'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('COS_DATA_DIR', join(home, 'data'))
  vi.stubEnv('COS_PROFILE_PATH', join(home, 'profile.json'))
  vi.stubEnv('COS_OPERATIONS_DIR', '')
  vi.stubEnv('COS_SCRIPTS_DIR', '')
  seed()
  await start()
})
afterEach(async () => {
  await new Promise<void>(resolve => { if (server) server.close(() => resolve()); else resolve() })
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('voice naming batch routes', () => {
  it('turn away a request with no token, like their neighbours', async () => {
    expect((await send(BATCH, undefined, null)).status).toBe(401)
    expect((await send(BATCH, { sourceRevision: 'x', items: ITEMS, confirm: true }, null)).status).toBe(401)
    expect((await send(`${BATCH}/00000000-0000-4000-8000-000000000000/undo`, { confirm: true }, null)).status).toBe(401)
  })

  it('run the whole flow: suggest, preview, confirm, list, a person changes one, Undo, Undo again', async () => {
    await suggestNames([['Voice 1'], ['Voice 2'], ['Voice 3']])
    const original = readFileSync(sidecarPath(), 'utf-8')
    const preview = await send(BATCH, { sourceRevision: revision(), items: ITEMS })
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ state: 'applied', dryRun: true, batchId: '', notNamed: [], undoAvailable: false })
    expect(preview.body.named.map((n: { labels: string[] }) => n.labels)).toEqual([['Voice 1'], ['Voice 2']])
    expect(readFileSync(sidecarPath(), 'utf-8')).toBe(original)
    expect(existsSync(data('mac-voice-naming-batches'))).toBe(false)

    const applied = await send(BATCH, { sourceRevision: revision(), items: ITEMS, confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.body).toMatchObject({ state: 'applied', notNamed: [], sourceRevision: revision(), undoAvailable: true })
    expect(applied.body.named).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', samplesAdded: 4 }, { labels: ['Voice 2'], name: 'Theo Marsh', samplesAdded: 4 }])
    expect(speakers().filter(s => s === 'Dana Reyes')).toHaveLength(CHUNKS_PER_VOICE)

    const listed = await send(BATCH)
    expect(listed.body.batches).toEqual([expect.objectContaining({ batchId: applied.body.batchId, state: 'applied', undoAvailable: true, named: applied.body.named })])

    const person = await send(`/meeting/${SESSION}/relabel`, { from: 'Dana Reyes', to: 'Rae Quill', confirm: true })
    expect(person.status).toBe(200)
    const undoPath = `${BATCH}/${applied.body.batchId}/undo`
    const undoPreview = await send(undoPath, {})
    expect(undoPreview.body).toMatchObject({ state: 'partial', dryRun: true, reverted: [{ labels: ['Voice 2'], name: 'Theo Marsh' }], left: [{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'label_changed_by_person' }] })
    expect(speakers().filter(s => s === 'Theo Marsh')).toHaveLength(CHUNKS_PER_VOICE)

    const undone = await send(undoPath, { confirm: true })
    expect(undone.status).toBe(200)
    expect(undone.body).toMatchObject({ state: 'partial', reverted: [{ labels: ['Voice 2'], name: 'Theo Marsh' }], left: [{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'label_changed_by_person' }], samplesRemoved: 8, sourceRevision: revision() })
    expect(speakers().filter(s => s === 'Rae Quill')).toHaveLength(CHUNKS_PER_VOICE)
    expect(speakers().filter(s => s === 'Voice 2')).toHaveLength(CHUNKS_PER_VOICE)
    expect(store().find(p => p.name === 'Theo Marsh')!.embeddings).toHaveLength(12)
    expect(store().find(p => p.name === 'Dana Reyes')!.embeddings).toHaveLength(12)

    const before = readFileSync(data('voice-profiles.json'), 'utf-8')
    const again = await send(undoPath, { confirm: true })
    expect(again.body).toEqual(undone.body)
    expect(readFileSync(data('voice-profiles.json'), 'utf-8')).toBe(before)
    expect((await send(BATCH)).body.batches[0]).toMatchObject({ state: 'undo_partial', undoAvailable: false })
  })

  it('answer a restart honestly: no suggestions in memory, so click again', async () => {
    const { resetVoiceSuggestionRunnerForTests } = await import('../lib/mac-voice-suggestions.js')
    resetVoiceSuggestionRunnerForTests(null)
    const out = await send(BATCH, { sourceRevision: revision(), items: ITEMS, confirm: true })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ state: 'refused', reason: 'suggestions_stale', batchId: '', named: [], undoAvailable: false })
    expect(out.body.notNamed).toHaveLength(2)
  })

  it('refuse what the job did not suggest, with the job itself as the source', async () => {
    await suggestNames([['Voice 1'], ['Voice 3']])
    const before = readFileSync(sidecarPath(), 'utf-8')
    // Voice 3 has no profile that fits, so nothing was suggested for it; Voice 2 was never scored.
    for (const items of [[{ labels: ['Voice 3'], name: 'Dana Reyes' }], [{ labels: ['Voice 2'], name: 'Theo Marsh' }]]) {
      const out = await send(BATCH, { sourceRevision: revision(), items, confirm: true })
      expect(out.body).toMatchObject({ state: 'refused', reason: 'not_high_confidence' })
    }
    expect(readFileSync(sidecarPath(), 'utf-8')).toBe(before)
  })

  it('answer 400 for a malformed id or body, and a refusal for an unknown batch', async () => {
    expect((await send('/meeting/bad%20id/voice-naming-batch')).status).toBe(400)
    expect((await send('/meeting/bad%20id/voice-naming-batch', { sourceRevision: 'x', items: ITEMS })).status).toBe(400)
    expect((await send('/meeting/bad%20id/voice-naming-batch/00000000-0000-4000-8000-000000000000/undo', { confirm: true })).status).toBe(400)
    expect((await send(`${BATCH}/not-a-batch/undo`, { confirm: true })).status).toBe(400)
    for (const body of [{}, { sourceRevision: 'x' }, { sourceRevision: 'x', items: [] }, { sourceRevision: 1, items: ITEMS }, { sourceRevision: 'x', items: [{ labels: [], name: 'Dana Reyes' }] }, { sourceRevision: 'x', items: [{ labels: ['Voice 1'], name: '' }] }, { sourceRevision: 'x', items: [{ labels: [1], name: 'Dana Reyes' }] }, { sourceRevision: 'x', items: Array(100).fill(ITEMS[0]) }]) {
      const out = await send(BATCH, body)
      expect(out.status).toBe(400)
      expect(out.body.reason).toBe('invalid_items')
    }
    const unknown = await send(`${BATCH}/00000000-0000-4000-8000-000000000000/undo`, { confirm: true })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toMatchObject({ state: 'refused', reason: 'batch_not_found', reverted: [], left: [], samplesRemoved: 0 })
    expect((await send(`/meeting/${SESSION.replace('1b2c', '0000')}/voice-naming-batch`)).body).toEqual({ batches: [] })
  })

  it('are a write, so they stay off the read-only list; the drain helper names exactly the two POSTs', async () => {
    const { isReadOnlyApiPost } = await import('../lib/work-search.js')
    const { isMacVoiceNamingBatchPost } = await import('../lib/mac-voice-naming-batch.js')
    const undoPath = `${BATCH}/00000000-0000-4000-8000-000000000000/undo`
    expect(isReadOnlyApiPost('POST', BATCH)).toBe(false)
    expect(isReadOnlyApiPost('POST', undoPath)).toBe(false)
    expect(isMacVoiceNamingBatchPost(BATCH)).toBe(true)
    expect(isMacVoiceNamingBatchPost(undoPath)).toBe(true)
    for (const other of [`/meeting/${SESSION}/relabel`, `${BATCH}/extra`, `${BATCH}/not-a-batch/undo`, '/meeting/save']) expect(isMacVoiceNamingBatchPost(other)).toBe(false)
  })
})
