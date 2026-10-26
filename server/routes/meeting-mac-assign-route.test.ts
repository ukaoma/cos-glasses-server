// POST /api/meeting/:sessionId/relabel with assignVoiceProfile: a Mac recording's
// `Voice N` assigned to an EXISTING voice profile (6.93.0).
//
// Driven over real HTTP against real files. The archived chunk WAVs are real files
// under COS_DATA_DIR/meeting-audio; only two seams are faked: the embedding
// extractor (it reads a marker out of the WAV bytes, so a wrong slice or a wrong
// chunk shows up as the wrong vector) and enrollEmbedding (a recorder). Everything
// else, including the join from sidecar position to raw capture index, is real.
//
// Fictional people only: this file is in a public repository.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MAC_ID = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
const MONTH = '2026-10'
const STEM = '2026-10-26_Vendor_Call_abc12345'
const SR = 16_000
const DIM = 192

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

/** Axes 'a'..'d' are orthogonal voices (every fourth dimension each); the last component carries the raw chunk index. */
type Axis = 'a' | 'b' | 'c' | 'd'
const AXES: Axis[] = ['a', 'b', 'c', 'd']
function voiceprint(marker: number, axis: Axis): Float32Array {
  const v = new Float32Array(DIM)
  const lane = AXES.indexOf(axis)
  for (let k = lane; k < DIM - 4; k += 4) v[k] = 100
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

function seedProfile(name: string, axis: Axis = 'a'): void {
  writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [{ name, embeddings: [Array.from(voiceprint(900, axis))], sources: ['g2-training'] }] }))
}

const sidecarNow = (): { labels: string[]; raw: string } => {
  const raw = readFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), 'utf-8')
  return { raw, labels: JSON.parse(raw).chunks.map((c: { speaker: string }) => c.speaker) }
}
function ledgerNow(sessionId: string): unknown[] {
  try { return readFileSync(join(dataDir, 'meeting-corrections', `${sessionId}.jsonl`), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

const enrolCalls: Array<{ name: string; source: string; marker: number; axis: Axis }> = []
let enrolThrowsOnCall = 0
let enrolFailsOnCall = 0
let extractFails = false
let runtimeAvailable = true

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU', getVocabulary: () => [], getOwnerName: () => 'Miles', getTranscriptionProfileStatus: () => ({}) }))
  enrolCalls.length = 0
  enrolThrowsOnCall = 0
  enrolFailsOnCall = 0
  extractFails = false
  runtimeAvailable = true
  vi.doMock('../lib/speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/speaker-embeddings.js')
    return {
      ...actual,
      isEmbeddingAvailable: () => runtimeAvailable,
      // Reads the first sample: axis * 100 + marker. A wrong slice reads the wrong voice. If any
      // later sample is on another axis the audio is contaminated: marker 99, a mix of both voices.
      extractEmbedding: (audio: Buffer) => {
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
      enrollEmbedding: (name: string, e: Float32Array, source: string) => {
        enrolCalls.push({ name, source, marker: e[DIM - 1], axis: AXES[[0, 1, 2, 3].find(l => e[l] > 0) ?? 0] })
        if (enrolThrowsOnCall > 0 && enrolCalls.length === enrolThrowsOnCall) throw new Error('voice profile store refused the write')
        // The store's near-duplicate gate says no without throwing.
        if (enrolFailsOnCall > 0 && enrolCalls.length === enrolFailsOnCall) return { success: false, dim: e.length, error: 'too similar to an existing sample' }
        return { success: true, dim: e.length }
      },
    }
  })
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingRouter({ store: new MeetingStore(root) }))
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
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
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
    expect(enrolCalls.every(c => c.axis === 'a' && c.name === 'Dana Reyes' && c.source === `correction:${MAC_ID}`)).toBe(true)
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

  it('a voice that sounds unlike the stored profile is reported below the floor, and the person still decides', async () => {
    standardMeeting(); seedProfile('Dana Reyes', 'b'); await startServer()
    const res = await post(url, { ...ASSIGN, dryRun: true })
    expect(res.json.enrolment.belowFloor).toBe(true)
    expect(res.json.enrolment.similarity).toBeLessThan(0.55)
    expect(res.json.enrolment.enrolled).toBe(3)
  }, T)

  it('more audio than the cap is spread across the whole meeting, bounded at 40 units and 20 samples', async () => {
    const raws = Array.from({ length: 55 }, (_, i) => i)
    seed(MAC_ID, raws.map(raw => ({ raw, speaker: 'Voice 2' })))
    for (const raw of raws) archive(MAC_ID, raw, wav([{ sec: 2.5, axis: 1, marker: raw }]))
    seedProfile('Dana Reyes'); await startServer()
    const preview = await post(url, { ...ASSIGN, dryRun: true })
    expect(preview.json.enrolment.attempted).toBe(40)
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.json.enrolment.enrolled).toBe(20)
    expect(enrolCalls).toHaveLength(20)
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
    seed(MAC_ID, [{ raw: 0, speaker: 'Voice 2' }, { raw: 2, speaker: 'Voice 2' }])
    archive(MAC_ID, 0, wav([{ sec: 4, axis: 1, marker: 0 }], 8000))
    archive(MAC_ID, 2, wav([{ sec: 4, axis: 1, marker: 2 }]))
    seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(enrolCalls.map(c => c.marker)).toEqual([2])
    expect(res.json.enrolment.attempted).toBe(1)
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

  it('a sample the store declines is not counted as added', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    enrolFailsOnCall = 2
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(enrolCalls).toHaveLength(3)
    expect(res.json.enrolment.enrolled).toBe(2)
    expect(res.json.enrolledEmbeddings).toBe(2)
  }, T)

  it('the report carries the merge floor it measured against', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    const res = await post(url, { ...ASSIGN, dryRun: true })
    expect(res.json.enrolment.floor).toBe(0.55)
  }, T)

  it('a store that throws mid-write leaves the rename in place and reports what landed', async () => {
    standardMeeting(); seedProfile('Dana Reyes'); await startServer()
    enrolThrowsOnCall = 2
    const res = await post(url, { ...ASSIGN, confirm: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels[1]).toBe('Dana Reyes')
    expect(res.json.enrolment).toMatchObject({ enrolled: 1, skipped: 'store_unavailable' })
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
