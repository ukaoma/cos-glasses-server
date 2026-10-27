// POST /api/meeting/:sessionId/relabel with assignVoiceProfile: a Mac recording's
// `Voice N` assigned to an EXISTING voice profile (6.93.0).
//
// Driven over real HTTP against real files. The archived chunk WAVs are real files
// under COS_DATA_DIR/meeting-audio; the faked seams are the embedding extractor (it reads
// a marker out of the WAV bytes, so a wrong slice or a wrong chunk shows up as the wrong
// vector) and the sherpa runtime (fake-speaker-runtime.ts). The profile store, the
// provenance eviction and the single batched write are the REAL code on a real temp
// store; `enrolCalls` only records what was handed to it. Everything else, including the
// join from sidecar position to raw capture index, is real.
//
// Fictional people only: this file is in a public repository.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fakeSpeakerRuntime } from '../lib/__fixtures__/fake-speaker-runtime.js'

const MAC_ID = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
const MONTH = '2026-10'
const STEM = '2026-10-26_Vendor_Call_abc12345'
const SR = 16_000
const DIM = 192
/** Samples a default-seeded profile holds: its own voiceprint plus eleven ordinary G2 samples (see seedProfile). */
const BASE = 12

let root = ''
let dataDir = ''
let server: Server | null = null
let baseUrl = ''

const SCRIBE = `# Vendor call

| Field | Value |
|-------|-------|
| **Date** | 2026-10-26 |
| **Capture source** | mac_system_audio |

## Summary

*Standalone recording.*

## Transcript

[Voice 1]: The renewal is due in March.
[Voice 2]: We can hold the price until then.
`

/**
 * Axes 'a'..'d' are orthogonal voices (every fourth of the first 128 dimensions each). A per-marker "texture" dimension
 * keeps two samples of the SAME voice distinct enough (cosine about 0.89) to pass the store's real 0.95 near-duplicate
 * gate, while two samples with the same marker modulo 63 are identical to it. The last component carries the marker.
 */
type Axis = 'a' | 'b' | 'c' | 'd'
const AXES: Axis[] = ['a', 'b', 'c', 'd']
function voiceprint(marker: number, axis: Axis): Float32Array {
  const v = new Float32Array(DIM)
  const lane = AXES.indexOf(axis)
  for (let k = lane; k < 128; k += 4) v[k] = 100
  v[128 + (marker % 63)] = 200
  v[DIM - 1] = marker
  return v
}

/** A canonical 16 kHz mono WAV whose every sample in a span is `axis * 100 + marker`. */
function wav(spans: Array<{ sec: number; axis: 1 | 2 | 3 | 4; marker: number }>, rate = SR): Buffer {
  const total = spans.reduce((n, s) => n + Math.round(s.sec * SR), 0)
  const pcm = Buffer.alloc(total * 2)
  let at = 0
  for (const s of spans) for (let i = 0; i < Math.round(s.sec * SR); i++) { pcm.writeInt16LE(s.axis * 100 + s.marker, at); at += 2 }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

interface Turn { speaker: string; startSec: number; endSec: number }
interface SeedChunk { raw: number; speaker: string; turns?: Turn[] }

function seed(sessionId: string, chunks: SeedChunk[], extra: Record<string, unknown> = {}): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), SCRIBE)
  const rows = chunks.map((c, i) => ({
    text: `segment ${i} about the renewal`, speaker: c.speaker, elapsed: i * 30000, similarity: 0,
    ...(c.turns ? { segments: c.turns.map(t => ({ ...t, text: 'x', similarity: 0 })) } : {}),
  }))
  const byRaw = new Map(chunks.map((c, p) => [c.raw, p]))
  const chunkEntries: unknown[] = []
  for (let raw = 0; raw <= Math.max(...chunks.map(c => c.raw)); raw++) {
    const p = byRaw.get(raw)
    chunkEntries.push(p === undefined ? { chunkIndex: raw, chunk: { text: '', speaker: 'Ext', elapsed: raw * 2000, similarity: 0 } } : { chunkIndex: raw, chunk: rows[p] })
  }
  writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify({
    schemaVersion: 2, sessionId, startTime: Date.now() - 3_600_000, durationMs: 600000,
    speakers: [...new Set(chunks.map(c => c.speaker))], chunks: rows, chunkEntries, ...extra,
  }, null, 2))
}

function archive(sessionId: string, raw: number, audio: Buffer): void {
  const dir = join(dataDir, 'meeting-audio', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `chunk_${String(raw).padStart(4, '0')}.wav`), audio)
}

// A profile may carry at most as many Mac-assigned samples as it has OTHER samples (6.93.0 polish), so a profile that is
// not seeded explicitly gets twelve ordinary G2 samples; a test that passes ten or more `more` samples chose its own mix.
function seedProfile(name: string, axis: Axis = 'a', moreIn: Array<{ marker: number; axis: Axis; source: string }> = [], withBase = moreIn.length < 10): void {
  const base = withBase ? Array.from({ length: 11 }, (_, i) => ({ marker: 30 + i, axis, source: 'g2-training' })) : []
  const more = [...moreIn, ...base]
  writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [
    { name, embeddings: [Array.from(voiceprint(60, axis)), ...more.map(m => Array.from(voiceprint(m.marker, m.axis)))], sources: ['g2-training', ...more.map(m => m.source)] },
  ] }))
}
function storeNow(): Array<{ name: string; embeddings: number[][]; sources: string[] }> {
  return JSON.parse(readFileSync(join(dataDir, 'voice-profiles.json'), 'utf-8')).profiles
}

const sidecarNow = (): { labels: string[]; raw: string } => {
  const raw = readFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), 'utf-8')
  return { raw, labels: JSON.parse(raw).chunks.map((c: { speaker: string }) => c.speaker) }
}
function ledgerNow(sessionId: string): unknown[] {
  try { return readFileSync(join(dataDir, 'meeting-corrections', `${sessionId}.jsonl`), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

const enrolCalls: Array<{ name: string; source: string; marker: number; axis: Axis }> = []
let batchThrows = false
let extractFails = false
let extractCalls = 0
let runtimeAvailable = true
let captureLive = false
let defaultCaptureProbe = false
let liveTranscriptionSessions = 0
let onFirstExtract: (() => void) | null = null

async function startServer(opts: { defaultProbe?: boolean } = {}): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU', getVocabulary: () => [], getOwnerName: () => 'Miles', getTranscriptionProfileStatus: () => ({}) }))
  enrolCalls.length = 0
  batchThrows = false
  extractFails = false
  extractCalls = 0
  captureLive = false
  defaultCaptureProbe = opts.defaultProbe === true
  liveTranscriptionSessions = 0
  onFirstExtract = null
  runtimeAvailable = true
  vi.doMock('../lib/speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/speaker-embeddings.js')
    ;(actual.__installSpeakerRuntimeForTests as (r: unknown) => void)(fakeSpeakerRuntime())
    return {
      ...actual,
      isEmbeddingAvailable: () => runtimeAvailable,
      // Reads the first sample: axis * 100 + marker. A wrong slice reads the wrong voice. If any
      // later sample is on another axis the audio is contaminated: marker 99, a mix of both voices.
      extractEmbedding: (audio: Buffer) => {
        extractCalls += 1
        if (onFirstExtract) { const fire = onFirstExtract; onFirstExtract = null; fire() }
        if (extractFails) return null
        const first = audio.readInt16LE(44)
        for (let at = 44; at + 1 < audio.length; at += 2) {
          if (Math.floor(audio.readInt16LE(at) / 100) !== Math.floor(first / 100)) {
            const mix = voiceprint(99, AXES[Math.floor(first / 100) - 1]); const other = voiceprint(99, AXES[Math.floor(audio.readInt16LE(at) / 100) - 1])
            for (let k = 0; k < DIM - 1; k++) mix[k] += other[k]
            return mix
          }
        }
        return voiceprint(first % 100, AXES[Math.floor(first / 100) - 1])
      },
      // Records what the route hands over, then runs the REAL batched enrolment against the temp store.
      enrollEmbeddingsBatch: (name: string, items: Array<{ embedding: Float32Array; source: string }>) => {
        for (const it of items) enrolCalls.push({ name, source: it.source, marker: it.embedding[DIM - 1], axis: AXES[[0, 1, 2, 3].find(l => it.embedding[l] > 0) ?? 0] })
        if (batchThrows) throw new Error('voice profile store refused the write')
        return (actual.enrollEmbeddingsBatch as (n: string, i: unknown) => unknown)(name, items)
      },
    }
  })
  // The router's own probe is getTranscriptionSessionLiveness().live > 0. Tests that exercise it set `defaultCaptureProbe`.
  vi.doMock('./transcribe-stream.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./transcribe-stream.js')
    return { ...actual, getTranscriptionSessionLiveness: () => ({ live: liveTranscriptionSessions, stale: 0, staleSessions: [] }) }
  })
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingRouter(defaultCaptureProbe ? { store: new MeetingStore(root) } : { store: new MeetingStore(root), captureActive: () => captureLive }))
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server!.address()
      if (!a || typeof a === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${a.port}`
      resolve()
    })
  })
}

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } }, res => {
      const parts: Buffer[] = []
      res.on('data', c => parts.push(Buffer.from(c)))
      res.on('end', () => { const t = Buffer.concat(parts).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-mac-assign-'))
  dataDir = mkdtempSync(join(tmpdir(), 'cos-mac-assign-data-'))
  process.env.COS_DATA_DIR = dataDir
})
afterEach(async () => {
  try { chmodSync(dataDir, 0o700) } catch { /* already gone */ }
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  vi.doUnmock('./transcribe-stream.js')
  delete process.env.COS_DATA_DIR
  for (const d of [root, dataDir]) if (d) rmSync(d, { recursive: true, force: true })
})

const T = 30_000
const ASSIGN = { from: 'Voice 2', to: 'Dana Reyes', assignVoiceProfile: true }
const url = `/api/meeting/${MAC_ID}/relabel`

/** Voice 1 on raw 0 and 4, Voice 2 (all one voice, axis 1) on raw 2 and 6, raw 8 mixed. */
function standardMeeting(): void {
  seed(MAC_ID, [
    { raw: 0, speaker: 'Voice 1' },
    { raw: 2, speaker: 'Voice 2' },
    { raw: 4, speaker: 'Voice 1' },
    { raw: 6, speaker: 'Voice 2' },
    // The turn is declared 0.05 s to 5.0 s, but the other voice is still audible for the first 0.1 s and from 4.95 s.
    { raw: 8, speaker: 'Voice 2', turns: [{ speaker: 'Voice 2', startSec: 0.05, endSec: 5 }, { speaker: 'Voice 1', startSec: 5, endSec: 9 }] },
  ])
  archive(MAC_ID, 0, wav([{ sec: 4, axis: 2, marker: 0 }]))
  archive(MAC_ID, 2, wav([{ sec: 4, axis: 1, marker: 2 }]))
  archive(MAC_ID, 4, wav([{ sec: 4, axis: 2, marker: 4 }]))
  archive(MAC_ID, 6, wav([{ sec: 4, axis: 1, marker: 6 }]))
  archive(MAC_ID, 8, wav([{ sec: 0.1, axis: 2, marker: 8 }, { sec: 4.85, axis: 1, marker: 8 }, { sec: 4.05, axis: 2, marker: 8 }]))
}

describe('preview: shows exactly what would be added and writes nothing', () => {
  it('a dry run reports the person, the sample count and the similarity; no file, ledger or profile changes', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const before = sidecarNow().raw
    const res = await post(url, { ...ASSIGN, dryRun: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toMatchObject({ person: 'Dana Reyes', enrolled: 3, attempted: 3, created: false, clusterSkipped: 0, skipped: null, belowFloor: false })
    expect(res.json.enrolment.similarity).toBeGreaterThan(0.6) // same axis; the marker component keeps it under 1
    expect(res.json.message).toContain('adding up to 3 voice sample(s) to Dana Reyes')
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().raw).toBe(before)
    expect(ledgerNow(MAC_ID)).toEqual([])
  }, T)

  it('with neither dryRun nor confirm it still previews and refuses with 400', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, ASSIGN)
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('confirmation_required')
    expect(res.json.enrolment.enrolled).toBe(3)
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels).toEqual(['Voice 1', 'Voice 2', 'Voice 1', 'Voice 2', 'Voice 2'])
  }, T)
})

describe('apply: renames, then writes the previewed samples once', () => {
  it('enrols only this voice, from the whole clean chunks and the sliced turn of the mixed chunk', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels).toEqual(['Voice 1', 'Dana Reyes', 'Voice 1', 'Dana Reyes', 'Dana Reyes'])
    // raw 2, 6 whole; raw 8 only its first 5 s (axis a). Never raw 0 or 4, never the axis-b half of raw 8.
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([2, 6, 8]) // 99 would be a slice that kept the other voice's edge
    expect(enrolCalls.every(c => c.axis === 'a' && c.name === 'Dana Reyes' && c.source === `mac-assign:${MAC_ID}`)).toBe(true)
    expect(res.json.enrolment).toMatchObject({ person: 'Dana Reyes', enrolled: 3, created: false, skipped: null })
    expect(res.json.enrolledEmbeddings).toBe(3)
    expect(readFileSync(join(root, MONTH, `${STEM}.md`), 'utf-8')).toContain('[Dana Reyes]: We can hold the price until then.')
    expect((ledgerNow(MAC_ID) as Array<{ phase: string }>).map(r => r.phase)).toEqual(['intent', 'applied'])
  }, T)

  it('the count applied equals the count previewed', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    const applied = await post(url, { ...ASSIGN, confirm: true })
    expect(applied.json.enrolment.enrolled).toBe(preview.json.enrolment.enrolled)
    expect(enrolCalls).toHaveLength(preview.json.enrolment.enrolled)
  }, T)

  it('a second apply finds no Voice 2 left, so it writes nothing more', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    await post(url, { ...ASSIGN, confirm: true })
    const calls = enrolCalls.length
    const again = await post(url, { ...ASSIGN, confirm: true })
    expect(again.status).toBe(422)
    expect(enrolCalls).toHaveLength(calls)
  }, T)

  it('a turn shorter than 3 s inside a mixed chunk is not used, and the chunk is counted', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2', turns: [{ speaker: 'Voice 2', startSec: 0, endSec: 2.9 }, { speaker: 'Voice 1', startSec: 2.9, endSec: 8 }] }, { raw: 2, speaker: 'Voice 2' }])
    archive(MAC_ID, 0, wav([{ sec: 2.9, axis: 1, marker: 0 }, { sec: 5.1, axis: 2, marker: 0 }]))
    archive(MAC_ID, 2, wav([{ sec: 4, axis: 1, marker: 2 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, dryRun: true })
    expect(res.json.enrolment).toMatchObject({ enrolled: 1, attempted: 1, multiVoiceSkipped: 1 })
  }, T)

  it('a chunk with a second voice and none of this voice\'s turns long enough adds nothing, and says so', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2', turns: [{ speaker: 'Voice 2', startSec: 0, endSec: 2 }, { speaker: 'Voice 1', startSec: 2, endSec: 8 }] }])
    archive(MAC_ID, 0, wav([{ sec: 2, axis: 1, marker: 0 }, { sec: 6, axis: 2, marker: 0 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.reason).toBe('nothing_to_enrol')
    expect(res.json.enrolment).toMatchObject({ skipped: 'no_usable_audio', multiVoiceSkipped: 1 })
    expect(sidecarNow().labels).toEqual(['Voice 2'])
    expect(enrolCalls).toEqual([])
  }, T)

  it('strangers under one label: the coherence gate keeps the dominant voice and reports the rest', async () => {
    seed(MAC_ID, [0, 2, 4, 6].map(raw => ({ raw, speaker: 'Voice 2' })))
    for (const [raw, axis] of [[0, 1], [2, 1], [4, 1], [6, 2]] as const) archive(MAC_ID, raw, wav([{ sec: 4, axis, marker: raw }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toMatchObject({ attempted: 4, clusterSkipped: 1, enrolled: 3 })
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([0, 2, 4])
  }, T)

  it('a voice that sounds unlike the stored profile is reported below the floor in the preview, and the confirm is refused', async () => {
    standardMeeting(); seedProfile('Dana Reyes', 'b'); await startServer()
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.status).toBe(200)
    expect(preview.json.enrolment.belowFloor).toBe(true)
    expect(preview.json.enrolment.similarity).toBeLessThan(0.55)
    expect(preview.json.enrolment.gates).toEqual(['below_floor'])
    expect(preview.json.message).toContain('refuse that unless you confirm adding it anyway')
    const refused = await post(url, { ...ASSIGN, confirm: true })
    expect(refused.status).toBe(409)
    expect(refused.json.reason).toBe('below_floor')
    expect(refused.json.enrolment).toMatchObject({ attempted: 3, groupSize: 3, similarity: preview.json.enrolment.similarity })
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels).toEqual(['Voice 1', 'Voice 2', 'Voice 1', 'Voice 2', 'Voice 2'])
    expect(ledgerNow(MAC_ID)).toEqual([])
    expect(storeNow()[0].embeddings).toHaveLength(BASE)
  }, T)

  it('force: true adds it anyway, as Mac-assigned samples, and says what it added', async () => {
    standardMeeting(); seedProfile('Dana Reyes', 'b'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true, force: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toMatchObject({ enrolled: 3, belowFloor: true, gates: ['below_floor'] })
    expect(sidecarNow().labels[1]).toBe('Dana Reyes')
    const profile = storeNow()[0]
    expect(profile.embeddings).toHaveLength(BASE + 3)
    expect(profile.sources.slice(BASE)).toEqual([`mac-assign:${MAC_ID}`, `mac-assign:${MAC_ID}`, `mac-assign:${MAC_ID}`])
  }, T)

  it('more audio than the cap is spread across the whole meeting, bounded at 40 units and 10 Mac-assigned samples', async () => {
    const raws = Array.from({ length: 55 }, (_, i) => i)
    seed(MAC_ID, raws.map(raw => ({ raw, speaker: 'Voice 2' })))
    for (const raw of raws) archive(MAC_ID, raw, wav([{ sec: 2.5, axis: 1, marker: raw }]))
    seedProfile('Dana Reyes'); await startServer()
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.json.enrolment.attempted).toBe(40)
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.json.enrolment.enrolled).toBe(10)
    expect(enrolCalls).toHaveLength(10)
    expect(storeNow()[0].embeddings).toHaveLength(BASE + 10)
    // The first 40 chunks alone could not reach past marker 39: the spread reaches the end of the meeting.
    expect(Math.max(...enrolCalls.map(c => c.marker))).toBeGreaterThan(45)
  }, T)

  it('final-pass turns win over the live turns they replaced', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2', turns: [{ speaker: 'Voice 2', startSec: 0, endSec: 9 }] }, { raw: 2, speaker: 'Voice 2' }])
    // The saved pass found a second voice in chunk 0; the live turns had called all of it Voice 2.
    const doc = JSON.parse(readFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), 'utf-8'))
    doc.chunkEntries[0].chunk.finalSegments = [{ speaker: 'Voice 2', startSec: 0.05, endSec: 5, text: 'x' }, { speaker: 'Voice 1', startSec: 5, endSec: 9, text: 'y' }]
    writeFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), JSON.stringify(doc))
    archive(MAC_ID, 0, wav([{ sec: 0.1, axis: 2, marker: 0 }, { sec: 4.85, axis: 1, marker: 0 }, { sec: 4.05, axis: 2, marker: 0 }]))
    archive(MAC_ID, 2, wav([{ sec: 4, axis: 1, marker: 2 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([0, 2]) // 99 would be the whole chunk, final turns ignored
  }, T)

  it('a whole chunk under the 2 s voiceprint minimum is skipped and counted', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2' }, { raw: 2, speaker: 'Voice 2' }])
    archive(MAC_ID, 0, wav([{ sec: 1.5, axis: 1, marker: 0 }]))
    archive(MAC_ID, 2, wav([{ sec: 4, axis: 1, marker: 2 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, dryRun: true })
    expect(res.json.enrolment).toMatchObject({ attempted: 1, shortSkipped: 1, enrolled: 1 })
  }, T)

  it('audio that is not 16 kHz is never embedded', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2' }, { raw: 2, speaker: 'Voice 2' }, { raw: 4, speaker: 'Voice 2' }])
    archive(MAC_ID, 0, wav([{ sec: 4, axis: 1, marker: 0 }], 8000))
    archive(MAC_ID, 2, wav([{ sec: 4, axis: 1, marker: 2 }]))
    archive(MAC_ID, 4, wav([{ sec: 4, axis: 1, marker: 4 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([2, 4])
    expect(res.json.enrolment.attempted).toBe(2)
  }, T)

  it('a crowd that agrees on nothing has no voice to learn: nothing is written and the rename is refused', async () => {
    seed(MAC_ID, [0, 2, 4, 6].map(raw => ({ raw, speaker: 'Voice 2' })))
    for (const [raw, axis] of [[0, 1], [2, 2], [4, 3], [6, 4]] as const) archive(MAC_ID, raw, wav([{ sec: 4, axis, marker: raw }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.enrolment).toMatchObject({ attempted: 4, clusterSkipped: 4, enrolled: 0, skipped: 'no_usable_audio' })
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels).toEqual(['Voice 2', 'Voice 2', 'Voice 2', 'Voice 2'])
  }, T)

  it('when the extractor yields nothing for any chunk there is nothing to add', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    extractFails = true
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.enrolment).toMatchObject({ attempted: 0, enrolled: 0, skipped: 'no_usable_audio' })
  }, T)

  it('a sample the store declines (a near duplicate of one already stored) is not counted as added', async () => {
    standardMeeting()
    // The store already holds an almost identical sample to raw chunk 6's vector (marker 6), so the REAL dedup gate says no.
    seedProfile('Dana Reyes', 'a', [{ marker: 6, axis: 'a', source: 'manual' }])
    await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(enrolCalls).toHaveLength(3)
    expect(res.json.enrolment.enrolled).toBe(2)
    expect(res.json.enrolledEmbeddings).toBe(2)
    expect(storeNow()[0].embeddings).toHaveLength(BASE + 1 + 2)
  }, T)

  it('the report carries the merge floor it measured against', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, dryRun: true })
    expect(res.json.enrolment.floor).toBe(0.55)
  }, T)

  it('a store that throws leaves the rename in place and reports nothing landed', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    batchThrows = true
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels[1]).toBe('Dana Reyes')
    expect(res.json.enrolment).toMatchObject({ enrolled: 0, skipped: 'store_unavailable' })
  }, T)

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a REAL disk failure: the rename stays, enrolled is 0, store_unavailable is named, and the profile is exactly as it was', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    // Prime the store cache, then stop the data directory accepting new files: the store's temp-file-then-rename write fails with a
    // genuine EACCES while the store stays readable. The correction ledger directory is created first so the rename itself can land.
    const lib = await import('../lib/speaker-embeddings.js')
    expect(lib.readVoiceProfiles().profiles[0].embeddings).toHaveLength(BASE)
    mkdirSync(join(dataDir, 'meeting-corrections'), { recursive: true })
    chmodSync(dataDir, 0o500)
    let res
    try { res = await post(url, { ...ASSIGN, confirm: true }) } finally { chmodSync(dataDir, 0o700) }
    expect(res.status).toBe(200)
    expect(sidecarNow().labels[1]).toBe('Dana Reyes')
    expect(res.json.enrolment).toMatchObject({ enrolled: 0, skipped: 'store_unavailable' })
    expect(res.json.enrolledEmbeddings).toBe(0)
    // Nothing from the failed batch is left in memory either: the cache must agree with the untouched file.
    expect(storeNow()[0].embeddings).toHaveLength(BASE)
    // No runtime reinstall: that would drop the cache and hide a cache that kept the failed samples.
    expect(lib.readVoiceProfiles().profiles[0].embeddings).toHaveLength(BASE)
  }, T)

  it('apply re-embeds nothing the preview already embedded', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    await post(url, { ...ASSIGN, dryRun: true })
    const afterPreview = extractCalls
    expect(afterPreview).toBe(3)
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.json.enrolment.enrolled).toBe(3)
    expect(extractCalls).toBe(afterPreview)
  }, T)
})

describe('refusals: nothing is changed', () => {
  it('a name that is not an enrolled profile is refused with 404, preview and apply alike', async () => {
    standardMeeting(); seedProfile('Someone Else'); await startServer()
    for (const mode of [{ dryRun: true }, { confirm: true }]) {
      const res = await post(url, { ...ASSIGN, ...mode })
      expect(res.status).toBe(404)
      expect(res.json.reason).toBe('unknown_profile')
    }
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels).toEqual(['Voice 1', 'Voice 2', 'Voice 1', 'Voice 2', 'Voice 2'])
    expect(ledgerNow(MAC_ID)).toEqual([])
  }, T)

  it('the profile name must match exactly: a different case is a different, unknown name', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { from: 'Voice 2', to: 'dana reyes', assignVoiceProfile: true, confirm: true })
    expect(res.status).toBe(404)
    expect(res.json.reason).toBe('unknown_profile')
    expect(enrolCalls).toEqual([])
  }, T)

  it('a recording whose audio is no longer retained is refused whole, with the reason', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2' }, { raw: 2, speaker: 'Voice 2' }])
    seedProfile('Dana Reyes'); await startServer()
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.status).toBe(200)
    expect(preview.json.enrolment).toMatchObject({ enrolled: 0, skipped: 'audio_not_retained', missingAudio: 2 })
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.reason).toBe('nothing_to_enrol')
    expect(sidecarNow().labels).toEqual(['Voice 2', 'Voice 2'])
    expect(ledgerNow(MAC_ID)).toEqual([])
    expect(enrolCalls).toEqual([])
  }, T)

  it('without the speaker model the apply is refused whole', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    runtimeAvailable = false
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.enrolment.skipped).toBe('store_unavailable')
    expect(sidecarNow().labels[1]).toBe('Voice 2')
  }, T)

  it('only a Mac recording may use it', async () => {
    seed('meeting_g2_plain', [{ raw: 0, speaker: 'Voice 2' }])
    seedProfile('Dana Reyes'); await startServer()
    const res = await post('/api/meeting/meeting_g2_plain/relabel', { ...ASSIGN, confirm: true })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('not_mac_capture')
    expect(sidecarNow().labels).toEqual(['Voice 2'])
  }, T)

  it('only an unnamed Voice N may be assigned', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Casey Lin' }])
    archive(MAC_ID, 0, wav([{ sec: 4, axis: 1, marker: 0 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { from: 'Casey Lin', to: 'Dana Reyes', assignVoiceProfile: true, confirm: true })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('not_a_voice_label')
    expect(enrolCalls).toEqual([])
  }, T)

  it('a placeholder target is never a profile, even if a profile carries that name', async () => {
    standardMeeting(); seedProfile('Voice 1'); await startServer()
    const res = await post(url, { from: 'Voice 2', to: 'Voice 1', assignVoiceProfile: true, confirm: true })
    expect(res.status).toBe(404)
    expect(res.json.reason).toBe('unknown_profile')
    expect(enrolCalls).toEqual([])
  }, T)
})

describe('unchanged defaults', () => {
  it('without the flag a Mac rename is still text only, even with the audio retained and the profile enrolled', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { from: 'Voice 2', to: 'Dana Reyes', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toEqual({ enrolled: 0, attempted: 0, created: false, clusterSkipped: 0, skipped: 'mac_capture' })
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[1]).toBe('Dana Reyes')
  }, T)

  it('the flag on a text-only preview adds no enrolment block', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { from: 'Voice 2', to: 'Dana Reyes', dryRun: true })
    expect(res.json.enrolment).toBeUndefined()
  }, T)
})

// ── 6.93.0: the gates that keep a wrong voice out of a real person's profile (QA B1) ──────────────────────

/** The R1 shape: the saved pass kept ONE number, `Voice 1`, over chunks that hold two people (axes 1 and 2). */
function r1Meeting(heard: Array<[number, 1 | 2 | 3 | 4]>): void {
  seed(MAC_ID, heard.map(([raw]) => ({ raw, speaker: 'Voice 1' })))
  for (const [raw, axis] of heard) archive(MAC_ID, raw, wav([{ sec: 4, axis, marker: raw }]))
}
const ASSIGN1 = { from: 'Voice 1', to: 'Dana Reyes', assignVoiceProfile: true }

describe('B1: below the floor, a mixed Voice N, or too little audio is refused unless forced', () => {
  it('R1 to assign: one number over two people, the other person dominant, Dana is the first person. Refused with the counts, nothing written', async () => {
    r1Meeting([[0, 2], [2, 2], [4, 2], [6, 1], [8, 1]]) // three of the second person, two of Dana's voice
    seedProfile('Dana Reyes', 'a'); await startServer()
    const preview = await post(url, { ...ASSIGN1, dryRun: true })
    expect(preview.json.enrolment).toMatchObject({ attempted: 5, groupSize: 3, clusterSkipped: 2, belowFloor: true, gates: ['below_floor', 'mixed_voice'] })
    expect(preview.json.enrolment.similarity).toBeLessThan(0.55)
    const refused = await post(url, { ...ASSIGN1, confirm: true })
    expect(refused.status).toBe(409)
    expect(refused.json.reason).toBe('below_floor')
    expect(refused.json.gates).toEqual(['below_floor', 'mixed_voice'])
    expect(refused.json.enrolment).toMatchObject({ attempted: 5, clusterSkipped: 2 })
    expect(enrolCalls).toEqual([])
    expect(storeNow()[0].embeddings).toHaveLength(BASE)
    expect(sidecarNow().labels.every(l => l === 'Voice 1')).toBe(true)
    expect(ledgerNow(MAC_ID)).toEqual([])
  }, T)

  it('a mixed Voice N is refused as mixed_voice even when the dominant voice does match the person', async () => {
    r1Meeting([[0, 1], [2, 1], [4, 1], [6, 2], [8, 2]]) // Dana's voice dominates 3 of 5
    seedProfile('Dana Reyes', 'a'); await startServer()
    const refused = await post(url, { ...ASSIGN1, confirm: true })
    expect(refused.status).toBe(409)
    expect(refused.json.reason).toBe('mixed_voice')
    expect(refused.json.enrolment).toMatchObject({ belowFloor: false, groupSize: 3, attempted: 5, clusterSkipped: 2, gates: ['mixed_voice'] })
    expect(enrolCalls).toEqual([])
  }, T)

  it('a kept group of two thirds or more is not mixed: one stray unit among four is reported but allowed', async () => {
    r1Meeting([[0, 1], [2, 1], [4, 1], [6, 2]])
    seedProfile('Dana Reyes', 'a'); await startServer()
    const res = await post(url, { ...ASSIGN1, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toMatchObject({ attempted: 4, clusterSkipped: 1, gates: [], enrolled: 3 })
  }, T)

  it('force: true writes it, from the same previewed vectors', async () => {
    r1Meeting([[0, 1], [2, 1], [4, 1], [6, 2], [8, 2]])
    seedProfile('Dana Reyes', 'a'); await startServer()
    const res = await post(url, { ...ASSIGN1, confirm: true, force: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toMatchObject({ enrolled: 3, gates: ['mixed_voice'] })
    expect(storeNow()[0].sources.slice(BASE)).toEqual(new Array(3).fill(`mac-assign:${MAC_ID}`))
  }, T)

  it('one short unit is too_little_audio: refused, then allowed with force', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2' }])
    archive(MAC_ID, 0, wav([{ sec: 2.5, axis: 1, marker: 0 }]))
    seedProfile('Dana Reyes'); await startServer()
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.json.enrolment).toMatchObject({ groupSize: 1, gates: ['too_little_audio'] })
    const refused = await post(url, { ...ASSIGN, confirm: true })
    expect(refused.status).toBe(409)
    expect(refused.json.reason).toBe('too_little_audio')
    expect(enrolCalls).toEqual([])
    const forced = await post(url, { ...ASSIGN, confirm: true, force: true })
    expect(forced.status).toBe(200)
    expect(forced.json.enrolment.enrolled).toBe(1)
  }, T)

  it('one unit that is a full 6 s chunk is enough on its own', async () => {
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2' }])
    archive(MAC_ID, 0, wav([{ sec: 6, axis: 1, marker: 0 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toMatchObject({ groupSize: 1, groupSec: 6, gates: [], enrolled: 1 })
  }, T)

  it('force does not skip the stalled-correction guard on an assignment', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    mkdirSync(join(dataDir, 'meeting-corrections'), { recursive: true })
    writeFileSync(join(dataDir, 'meeting-corrections', `${MAC_ID}.jsonl`), JSON.stringify({ id: 'x:Voice 2>Someone:1', phase: 'intent', at: new Date().toISOString(), from: 'Voice 2', to: 'Someone', chunks: [1], scope: 'meeting' }) + '\n')
    const res = await post(url, { ...ASSIGN, confirm: true, force: true })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('correction_pending')
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[1]).toBe('Voice 2')
  }, T)
})

describe('B3: the wearer profile is never a target', () => {
  it('preview and confirm both refuse with owner_profile, and nothing is read or written', async () => {
    standardMeeting(); seedProfile('MU'); await startServer()
    for (const mode of [{ dryRun: true }, { confirm: true }, { confirm: true, force: true }]) {
      const res = await post(url, { from: 'Voice 2', to: 'MU', assignVoiceProfile: true, ...mode })
      expect(res.status).toBe(409)
      expect(res.json.reason).toBe('owner_profile')
    }
    expect(extractCalls).toBe(0)
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[1]).toBe('Voice 2')
    expect(storeNow()[0].embeddings).toHaveLength(BASE)
  }, T)

  it('the match ignores case and surrounding space', async () => {
    standardMeeting(); seedProfile('MU'); await startServer()
    const res = await post(url, { from: 'Voice 2', to: 'mu', assignVoiceProfile: true, confirm: true })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('owner_profile')
    expect(enrolCalls).toEqual([])
  }, T)
})

describe('B4: it never competes with a live recording, and never lets the meeting change under it', () => {
  it('capture_active: refused before any audio is read, on preview and confirm, with nothing changed', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    captureLive = true
    for (const mode of [{ dryRun: true }, { confirm: true }]) {
      const res = await post(url, { ...ASSIGN, ...mode })
      expect(res.status).toBe(409)
      expect(res.json.reason).toBe('capture_active')
      expect(res.json.retryable).toBe(true)
    }
    expect(extractCalls).toBe(0)
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[1]).toBe('Voice 2')
  }, T)

  it('the router\'s own probe (live transcription sessions) refuses too, and a stale-only server does not', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer({ defaultProbe: true })
    liveTranscriptionSessions = 1
    const refused = await post(url, { ...ASSIGN, dryRun: true })
    expect(refused.status).toBe(409)
    expect(refused.json.reason).toBe('capture_active')
    expect(extractCalls).toBe(0)
    liveTranscriptionSessions = 0
    expect((await post(url, { ...ASSIGN, dryRun: true })).status).toBe(200)
  }, T)

  it('a text-only rename is NOT held up by a live capture', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    captureLive = true
    const res = await post(url, { from: 'Voice 2', to: 'Dana Reyes', confirm: true })
    expect(res.status).toBe(200)
  }, T)

  it('a capture that starts while the audio is being read stops the write', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    onFirstExtract = () => { captureLive = true }
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('capture_active')
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[1]).toBe('Voice 2')
  }, T)

  it('a finalization job that appears while the audio is read stops the write: meeting_finalizing, nothing changed', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    // Imported after startServer, which reset the module registry: the store's root is fixed when its module loads.
    const { MeetingFinalizationJobStore } = await import('../lib/meeting-finalization-jobs.js')
    const before = storeNow()[0]
    onFirstExtract = () => {
      new MeetingFinalizationJobStore().save({
        sessionId: MAC_ID, meetingPath: join(dataDir, 'recordings', 'x.md'), sidecarPath: join(dataDir, 'recordings', 'x.g2-chunks.json'),
        audioDir: null, streamingWordCount: 0, phase: 'capture_pending', claimPending: false,
      })
    }
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('meeting_finalizing')
    expect(enrolCalls).toEqual([])
    expect(storeNow()[0]).toEqual(before)
    expect(sidecarNow().labels[1]).toBe('Voice 2')
    expect(ledgerNow(MAC_ID)).toEqual([])
  }, T)

  it('meeting_changed: another write to the meeting while the plan yielded refuses the apply, and nothing is written', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    onFirstExtract = () => {
      const path = join(root, MONTH, `${STEM}.g2-chunks.json`)
      const doc = JSON.parse(readFileSync(path, 'utf-8'))
      doc.speakers = [...doc.speakers, 'Someone Else']
      writeFileSync(path, JSON.stringify(doc, null, 2))
    }
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('meeting_changed')
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[1]).toBe('Voice 2')
    expect(ledgerNow(MAC_ID)).toEqual([])
  }, T)

  it('a change to the transcript file alone, while the audio is read, fails the caller\'s expectedRevision: meeting_changed', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const md = join(root, MONTH, `${STEM}.md`)
    const sidecar = join(root, MONTH, `${STEM}.g2-chunks.json`)
    // The same digest the review panel hands back as expectedRevision: sha256 over JSON.stringify of each file's text.
    const revision = () => {
      const hash = createHash('sha256')
      for (const path of [md, sidecar]) hash.update(JSON.stringify(readFileSync(path, 'utf-8')))
      return hash.digest('hex')
    }
    const expectedRevision = revision()
    onFirstExtract = () => writeFileSync(md, readFileSync(md, 'utf-8') + '\nA note added by someone else.\n')
    const res = await post(url, { ...ASSIGN, confirm: true, expectedRevision })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('meeting_changed')
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[1]).toBe('Voice 2')
  }, T)

  it('assign_in_progress: a second request on the same meeting while the first is still reading is refused', async () => {
    const raws = Array.from({ length: 55 }, (_, i) => i)
    seed(MAC_ID, raws.map(raw => ({ raw, speaker: 'Voice 2' })))
    for (const raw of raws) archive(MAC_ID, raw, wav([{ sec: 2.5, axis: 1, marker: raw }]))
    seedProfile('Dana Reyes'); await startServer()
    const [a, b] = await Promise.all([post(url, { ...ASSIGN, dryRun: true }), post(url, { ...ASSIGN, dryRun: true })])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    expect([a, b].find(r => r.status === 409)!.json.reason).toBe('assign_in_progress')
    // Once the first has finished the meeting can be planned again.
    expect((await post(url, { ...ASSIGN, dryRun: true })).status).toBe(200)
  }, T)

  it('a wrong expectedRevision is refused up front, before any audio is read', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true, expectedRevision: 'not-the-revision' })
    expect(res.status).toBe(409)
    expect(enrolCalls).toEqual([])
  }, T)

  it('the event loop keeps turning while the audio is read: other callbacks run between units', async () => {
    const raws = Array.from({ length: 30 }, (_, i) => i)
    seed(MAC_ID, raws.map(raw => ({ raw, speaker: 'Voice 2' })))
    for (const raw of raws) archive(MAC_ID, raw, wav([{ sec: 2.5, axis: 1, marker: raw }]))
    seedProfile('Dana Reyes'); await startServer()
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 0)
    try { await post(url, { ...ASSIGN, dryRun: true }) } finally { clearInterval(timer) }
    expect(extractCalls).toBe(30)
    expect(ticks).toBeGreaterThan(5)
  }, T)
})

describe('B2: Mac-assigned samples never displace anything else (real store, real eviction)', () => {
  it('into a full profile with no Mac-assigned sample to replace: refused whole, with the reason, nothing changed', async () => {
    standardMeeting()
    const fill = Array.from({ length: 39 }, (_, i) => ({ marker: 20 + (i % 30), axis: 'a' as Axis, source: i < 12 ? `correction:meeting_x${i}` : i < 24 ? 'g2-training' : 'fireflies' }))
    seedProfile('Dana Reyes', 'a', fill); await startServer()
    const before = storeNow()[0]
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.json.enrolment.skipped).toBe('profile_full')
    expect(preview.json.message).toContain('Assigning is not possible')
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.enrolment.skipped).toBe('profile_full')
    expect(storeNow()[0]).toEqual(before)
    expect(sidecarNow().labels[1]).toBe('Voice 2')
  }, T)

  it('into a nearly full profile it uses the free slots only, and every correction, g2-training and fireflies sample survives', async () => {
    standardMeeting()
    const fill = Array.from({ length: 38 }, (_, i) => ({ marker: 20 + (i % 30), axis: 'a' as Axis, source: i < 12 ? `correction:meeting_x${i}` : i < 24 ? 'g2-training' : 'fireflies' }))
    seedProfile('Dana Reyes', 'a', fill); await startServer()
    const before = storeNow()[0]
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment.enrolled).toBe(1) // one free slot
    const after = storeNow()[0]
    expect(after.embeddings).toHaveLength(40)
    expect(after.sources.slice(0, 39)).toEqual(before.sources)
    expect(after.sources[39]).toBe(`mac-assign:${MAC_ID}`)
  }, T)

  it('with Mac-assigned samples already at the profile cap, a new assignment replaces the oldest of THEM, not a correction', async () => {
    standardMeeting()
    const fill = [
      ...Array.from({ length: 10 }, (_, i) => ({ marker: 10 + i, axis: 'a' as Axis, source: `mac-assign:mac_old${i}` })),
      ...Array.from({ length: 20 }, (_, i) => ({ marker: 20 + i, axis: 'a' as Axis, source: i < 10 ? `correction:meeting_x${i}` : 'g2-training' })),
    ]
    seedProfile('Dana Reyes', 'a', fill); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment.enrolled).toBe(3)
    const sources = storeNow()[0].sources
    expect(sources.filter(s => s.startsWith('correction:'))).toHaveLength(10)
    expect(sources.filter(s => s === 'g2-training')).toHaveLength(11) // the seed sample plus ten
    expect(sources.filter(s => s.startsWith('mac-assign:mac_old'))).toHaveLength(7)
    expect(sources.filter(s => s === `mac-assign:${MAC_ID}`)).toHaveLength(3)
  }, T)

  it('a full profile whose Mac-assigned samples can be replaced still takes the new ones, and nothing else is displaced', async () => {
    standardMeeting()
    const fill = [
      ...Array.from({ length: 3 }, (_, i) => ({ marker: 10 + i, axis: 'a' as Axis, source: `mac-assign:mac_old${i}` })),
      ...Array.from({ length: 36 }, (_, i) => ({ marker: 20 + (i % 30), axis: 'a' as Axis, source: i < 12 ? `correction:meeting_x${i}` : i < 24 ? 'g2-training' : 'fireflies' })),
    ]
    seedProfile('Dana Reyes', 'a', fill); await startServer()
    const before = storeNow()[0]
    expect(before.embeddings).toHaveLength(40)
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.json.enrolment).toMatchObject({ skipped: null, enrolled: 3 })
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment.enrolled).toBe(3)
    const after = storeNow()[0]
    expect(after.embeddings).toHaveLength(40)
    expect(after.sources.filter(s => s === `mac-assign:${MAC_ID}`)).toHaveLength(3)
    expect(after.sources.filter(s => s.startsWith('mac-assign:mac_old'))).toHaveLength(0)
    expect(after.sources.filter(s => s.startsWith('correction:'))).toHaveLength(12)
    expect(after.sources.filter(s => s === 'fireflies')).toHaveLength(12)
  }, T)

  it('a small profile takes at most as many Mac-assigned samples as it has other samples, never the flat ten', async () => {
    standardMeeting()
    seedProfile('Dana Reyes', 'a', [{ marker: 31, axis: 'a', source: 'manual' }], false) // two ordinary samples
    await startServer()
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.json.enrolment.enrolled).toBe(2) // three selectable, capacity two
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment.enrolled).toBe(2)
    const sources = storeNow()[0].sources
    expect(sources.filter(s => s.startsWith('mac-assign:'))).toHaveLength(2)
    expect(sources.filter(s => !s.startsWith('mac-assign:'))).toHaveLength(2)
  }, T)

  it('end to end: "Not in this meeting" on the named row removes this meeting\'s Mac-assigned samples and nobody else\'s', async () => {
    standardMeeting()
    const other = { marker: 50, axis: 'a' as Axis, source: 'mac-assign:mac_9f9f9f9f-0000-4000-8000-000000000001' }
    seedProfile('Dana Reyes', 'a', [other])
    await startServer()
    const assigned = await post(url, { ...ASSIGN, confirm: true })
    expect(assigned.status).toBe(200)
    expect(sidecarNow().labels[1]).toBe('Dana Reyes')
    expect(storeNow()[0].sources.filter(s => s === `mac-assign:${MAC_ID}`)).toHaveLength(3)
    const nonMacBefore = storeNow()[0].sources.filter(s => !s.startsWith('mac-assign:'))

    const res = await post(`/api/meeting/${MAC_ID}/deattribute`, { from: 'Dana Reyes', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.training.retracted).toBe(3)
    const after = storeNow()[0].sources
    expect(after.filter(s => s === `mac-assign:${MAC_ID}`)).toHaveLength(0)
    expect(after.filter(s => s === other.source)).toHaveLength(1) // another meeting's assignment is untouched
    expect(after.filter(s => !s.startsWith('mac-assign:'))).toEqual(nonMacBefore)
    expect(sidecarNow().labels[1]).not.toBe('Dana Reyes')
  }, T)

  it('"Not in this meeting" still retracts the Mac-assigned samples by session', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    await post(url, { ...ASSIGN, confirm: true })
    expect(storeNow()[0].sources.filter(s => s === `mac-assign:${MAC_ID}`)).toHaveLength(3)
    const { isSampleFromSession } = await import('../lib/training-audio-provenance.js')
    expect(storeNow()[0].sources.filter(s => isSampleFromSession(s, MAC_ID))).toHaveLength(3)
    expect(isSampleFromSession(`mac-assign:${MAC_ID}x`, MAC_ID)).toBe(false)
  }, T)
})
