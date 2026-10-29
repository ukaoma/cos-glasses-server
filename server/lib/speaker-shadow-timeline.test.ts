import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ShadowInputError, buildShadowTimeline, pcm16WavFile, readPcm16Wav, shadowEntries, shadowHumanProtectedVoices, shadowLabelsHash, shadowProductionSegments,
} from './speaker-shadow-timeline.js'
import {
  SHADOW_MODEL_ENTRIES, SHADOW_MODEL_FILES, SHADOW_MODEL_FOLDER, SHADOW_MODEL_REVISION, SHADOW_REVISION_MARKER,
  prepareShadowHome, shadowModelsPresent, verifyShadowModels,
} from './speaker-shadow-models.js'
import { SR, pcmWav, syntheticMeeting, syntheticSegments } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

const scratch = mkdtempSync(join(tmpdir(), 'speaker-shadow-timeline-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function chunk(index: number, elapsed: number, samples: number, extra: Record<string, unknown> = {}) {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) pcm[i] = ((index + 1) * 100 + (i % 7)) as number
  const wav = pcmWav(pcm)
  return { wav, entry: { chunkIndex: index, chunk: { text: `t${index}`, speaker: 'Voice 1', elapsed, audioSha256: sha(wav), segments: [], ...extra } } }
}

describe('speaker shadow timeline (round3/propose.py build_timeline)', () => {
  it('places, trims overlapping tails, zero-fills gaps, and verifies every original', async () => {
    const dir = join(scratch, 'place')
    mkdirSync(dir)
    // chunk 1 starts 0.5 s into chunk 0's 1 s, so chunk 0's tail is trimmed; a 0.25 s gap follows chunk 1.
    const a = chunk(0, 0, SR), b = chunk(1, 500, SR), c = chunk(2, 1750, SR / 2)
    for (const x of [a, b, c]) writeFileSync(join(dir, `chunk_000${x.entry.chunkIndex}.wav`), x.wav)
    const t = await buildShadowTimeline([c.entry, a.entry, b.entry], i => join(dir, `chunk_000${i}.wav`))
    expect(t.rows).toEqual([
      { rawChunkIndex: 0, startSample: 0, sampleCount: SR, usedSampleCount: SR / 2 },
      { rawChunkIndex: 1, startSample: SR / 2, sampleCount: SR, usedSampleCount: SR },
      { rawChunkIndex: 2, startSample: 28_000, sampleCount: SR / 2, usedSampleCount: SR / 2 },
    ])
    expect(t.total).toBe(36_000)
    expect(t.pcm.readInt16LE(0)).toBe(100)
    expect(t.pcm.readInt16LE((SR / 2) * 2)).toBe(200)
    expect(t.pcm.readInt16LE(27_000 * 2)).toBe(0)
    expect(t.pcm.readInt16LE(28_000 * 2)).toBe(300)
    expect(t.verified).toBe(3)
    expect(t.pcmSHA256).toBe(sha(t.pcm))
  })

  it('places the start at floor(elapsed_ms * 16 + 0.5)', async () => {
    const dir = join(scratch, 'clock')
    mkdirSync(dir)
    const a = chunk(0, 0.03125, SR / 10), b = chunk(1, 1000.03, SR / 10)
    for (const x of [a, b]) writeFileSync(join(dir, `chunk_000${x.entry.chunkIndex}.wav`), x.wav)
    const t = await buildShadowTimeline([a.entry, b.entry], i => join(dir, `chunk_000${i}.wav`))
    expect(t.rows.map(r => r.startSample)).toEqual([Math.floor(0.03125 * 16 + 0.5), Math.floor(1000.03 * 16 + 0.5)])
  })

  it('refuses drift, a missing original, a non-PCM16 file and a fully shadowed original', async () => {
    const dir = join(scratch, 'refuse')
    mkdirSync(dir)
    const a = chunk(0, 0, SR), b = chunk(1, 0, SR)
    writeFileSync(join(dir, 'chunk_0000.wav'), a.wav)
    writeFileSync(join(dir, 'chunk_0001.wav'), b.wav)
    const at = (i: number) => join(dir, `chunk_000${i}.wav`)
    await expect(buildShadowTimeline([a.entry, b.entry], at)).rejects.toMatchObject({ reason: 'bad_sidecar' })
    await expect(buildShadowTimeline([{ ...a.entry, chunk: { ...a.entry.chunk, audioSha256: '0'.repeat(64) } }], at)).rejects.toMatchObject({ reason: 'audio_drift' })
    await expect(buildShadowTimeline([{ ...a.entry, chunkIndex: 7 }], at)).rejects.toMatchObject({ reason: 'audio_missing' })
    const stereo = Buffer.from(a.wav); stereo.writeUInt16LE(2, 22)
    writeFileSync(join(dir, 'chunk_0002.wav'), stereo)
    await expect(buildShadowTimeline([{ chunkIndex: 2, chunk: { elapsed: 0 } }], at)).rejects.toMatchObject({ reason: 'audio_format' })
    expect(() => readPcm16Wav(Buffer.from('nope'))).toThrow(ShadowInputError)
  })

  it('lists unhashed originals and the ones that carry text', async () => {
    const dir = join(scratch, 'unhashed')
    mkdirSync(dir)
    const a = chunk(0, 0, SR), b = chunk(1, 1000, SR)
    writeFileSync(join(dir, 'chunk_0000.wav'), a.wav)
    writeFileSync(join(dir, 'chunk_0001.wav'), b.wav)
    const { audioSha256: _a, ...noHashA } = a.entry.chunk as Record<string, unknown>
    const { audioSha256: _b, ...noHashB } = b.entry.chunk as Record<string, unknown>
    const t = await buildShadowTimeline([{ chunkIndex: 0, chunk: { ...noHashA, text: ' 　 ' } }, { chunkIndex: 1, chunk: noHashB }], i => join(dir, `chunk_000${i}.wav`))
    expect([t.verified, t.unhashed, t.unhashedWithText]).toEqual([0, 2, [1]])
  })

  it('writes the 44-byte header Python wave writes', () => {
    const wav = pcm16WavFile(Buffer.alloc(8))
    expect(wav.length).toBe(52)
    expect(wav.toString('hex', 0, 44)).toBe('52494646' + '2c000000' + '57415645666d7420' + '10000000' + '0100' + '0100' + '803e0000' + '007d0000' + '0200' + '1000' + '64617461' + '08000000')
    expect(readPcm16Wav(wav).sampleCount).toBe(4)
  })

  it('produces the production segments the research tool does, from the synthetic sidecar', async () => {
    const meeting = syntheticMeeting()
    const dir = join(scratch, 'synthetic')
    mkdirSync(dir)
    for (const [i, wav] of meeting.wavs) writeFileSync(join(dir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
    const entries = shadowEntries(meeting.sidecar)
    const t = await buildShadowTimeline(entries, i => join(dir, `chunk_${String(i).padStart(4, '0')}.wav`))
    const { segs, sources } = shadowProductionSegments(entries, t.rows, t.total)
    expect(segs).toEqual(syntheticSegments())
    expect(sources[0]).toEqual({ chunkIndex: 0, start: 0, end: 10, abs: 0 })
  })

  it('skips segments the research tool skips, and refuses a non-string speaker', () => {
    const rows = [{ rawChunkIndex: 0, startSample: 0, sampleCount: SR * 2, usedSampleCount: SR * 2 }]
    const entries = shadowEntries({ chunkEntries: [{ chunkIndex: 0, chunk: { elapsed: 0, segments: [
      { speaker: 'Voice 1', startSec: 0, endSec: 1 }, { speaker: '', startSec: 0, endSec: 1 }, { speaker: 'Voice 2', startSec: '0', endSec: 1 },
      { speaker: 'Voice 3', startSec: 1.5, endSec: 1.5 }, { speaker: 'Voice 4', startSec: 1, endSec: 9 }, { speaker: 'Voice 5', startSec: true, endSec: 1.5 },
    ] } }] })
    expect(shadowProductionSegments(entries, rows, SR * 2).segs).toEqual([[0, SR, 'Voice 1'], [SR, SR * 2, 'Voice 4'], [SR, SR * 1.5, 'Voice 5']])
    const bad = shadowEntries({ chunkEntries: [{ chunkIndex: 0, chunk: { elapsed: 0, segments: [{ speaker: 5, startSec: 0, endSec: 1 }] } }] })
    expect(() => shadowProductionSegments(bad, rows, SR * 2)).toThrow(ShadowInputError)
  })

  it('validates the sidecar entries', () => {
    expect(() => shadowEntries({})).toThrow(/no chunkEntries/)
    expect(() => shadowEntries({ chunkEntries: [{ chunkIndex: 0, chunk: { elapsed: 0 } }, { chunkIndex: 0, chunk: { elapsed: 1 } }] })).toThrow(/duplicate/)
    expect(() => shadowEntries({ chunkEntries: [{ chunkIndex: 0, chunk: { elapsed: 'x' } }] })).toThrow(/elapsed/)
    expect(() => shadowEntries({ chunkEntries: [{ chunkIndex: 0, chunk: { elapsed: 0, segments: {} } }] })).toThrow(/segments/)
  })

  it('hashes exactly what a later correction would change', () => {
    const entries = shadowEntries(syntheticMeeting().sidecar)
    const h = shadowLabelsHash(entries)
    const textOnly = entries.map(e => ({ ...e, chunk: { ...e.chunk, text: 'edited words' } }))
    expect(shadowLabelsHash(textOnly)).toBe(h)
    const relabeled = entries.map((e, i) => i === 3 ? { ...e, chunk: { ...e.chunk, segments: [{ ...(e.chunk.segments as any[])[0], speaker: 'Dana Fictional' }] } } : e)
    expect(shadowLabelsHash(relabeled)).not.toBe(h)
  })

  it('names Voice labels on chunks a human touched (a hint, never a gate)', () => {
    const entries = shadowEntries({ chunkEntries: [
      { chunkIndex: 0, chunk: { elapsed: 0, speaker: 'Voice 2', segments: [{ speaker: 'Voice 2', startSec: 0, endSec: 1, speakerOrigin: 'manual' }] } },
      { chunkIndex: 1, chunk: { elapsed: 1000, speaker: 'Voice 3', segments: [{ speaker: 'Voice 3', startSec: 0, endSec: 1 }] } },
      { chunkIndex: 2, chunk: { elapsed: 2000, speaker: 'Dana Fictional', manuallyCorrected: true, segments: [{ speaker: 'Voice 4', startSec: 0, endSec: 1 }] } },
    ] })
    expect(shadowHumanProtectedVoices(entries)).toEqual(['Voice 2', 'Voice 4'])
  })
})

describe('speaker shadow models (pinned, never downloaded)', () => {
  it('pins FluidAudio 0.17.4 diarizer revision and its revision marker', () => {
    expect(SHADOW_MODEL_REVISION).toBe('df2625ac79a7ac6b65ad868fee6d80f320da4232')
    expect(SHADOW_MODEL_FOLDER).toBe('speaker-diarization')
    expect(createHash('sha256').update(SHADOW_REVISION_MARKER.content).digest('hex')).toBe(SHADOW_REVISION_MARKER.sha256)
    expect(SHADOW_MODEL_FILES).toHaveLength(21)
    expect(SHADOW_MODEL_ENTRIES).toEqual(['Embedding.mlmodelc', 'FBank.mlmodelc', 'PldaRho.mlmodelc', 'Segmentation.mlmodelc', 'plda-parameters.json'])
    expect(SHADOW_MODEL_FILES.every(f => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0)).toBe(true)
  })

  it('reports missing and mismatched models without running anything', async () => {
    expect(await verifyShadowModels(join(scratch, 'no-models'))).toMatchObject({ ok: false, reason: 'models_missing' })
    const dir = join(scratch, 'wrong-models')
    for (const f of SHADOW_MODEL_FILES) { mkdirSync(join(dir, f.path, '..'), { recursive: true }); writeFileSync(join(dir, f.path), Buffer.alloc(f.size)) }
    expect(shadowModelsPresent(dir)).toBe(true)
    expect(await verifyShadowModels(dir)).toMatchObject({ ok: false, reason: 'models_mismatch' })
    expect(shadowModelsPresent(join(scratch, 'no-models'))).toBe(false)
  })

  it.skipIf(!process.env.COS_SPEAKER_SHADOW_MODELS_FIXTURE)('verifies a real copy of the pinned models', async () => {
    expect(await verifyShadowModels(process.env.COS_SPEAKER_SHADOW_MODELS_FIXTURE!)).toMatchObject({ ok: true, bytes: 21_599_417 })
  })

  it('rebuilds the private HOME folder from links and the marker, never touching the targets', () => {
    const models = join(scratch, 'verified')
    for (const entry of SHADOW_MODEL_ENTRIES) mkdirSync(join(models, entry), { recursive: true })
    writeFileSync(join(models, 'Embedding.mlmodelc', 'keep.bin'), 'model bytes')
    const home = join(scratch, 'home')
    const folder = prepareShadowHome(home, models)
    writeFileSync(join(folder, 'stray-download.bin'), 'x')
    rmSync(join(folder, SHADOW_REVISION_MARKER.path))
    symlinkSync('/nonexistent', join(folder, 'extra-link'))
    expect(prepareShadowHome(home, models)).toBe(folder)
    expect(existsSync(join(folder, 'stray-download.bin'))).toBe(false)
    expect(existsSync(join(folder, 'extra-link'))).toBe(false)
    expect(readFileSync(join(folder, SHADOW_REVISION_MARKER.path), 'utf8')).toBe(SHADOW_REVISION_MARKER.content)
    for (const entry of SHADOW_MODEL_ENTRIES) {
      expect(lstatSync(join(folder, entry)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(folder, entry))).toBe(join(models, entry))
    }
    expect(readFileSync(join(models, 'Embedding.mlmodelc', 'keep.bin'), 'utf8')).toBe('model bytes')
  })
})
