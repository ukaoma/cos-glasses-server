import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedTranscriptChunk } from '../routes/transcribe-stream.js'

let dir = ''
let M: typeof import('./meeting-batch-transcribe.js')

function wav(): Buffer {
  const pcm = Buffer.alloc(3200)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24); h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

const entries: IndexedTranscriptChunk[] = [0, 6_000].map((elapsed, chunkIndex) => ({ chunkIndex, chunk: { text: `c${chunkIndex}`, speaker: 'MU', elapsed, similarity: 1 } as any }))
const segment = { startChunkIdx: 0, endChunkIdx: 1, startElapsed: 0, endElapsed: 6_000, speakers: ['MU'] }
const words = (text: string, at = 0) => text.split(' ').map((word, i) => ({ word, start: at + i * 0.4, end: at + i * 0.4 + 0.3, probability: 0.9 }))

function deps(over: Partial<import('./meeting-batch-transcribe.js').HqDecodeDeps> = {}) {
  const calls: string[] = []
  const d = {
    whisper: vi.fn(async (_wav: Buffer, _ctx: string | undefined, opts: any) => {
      calls.push(`whisper:${opts.timestamps ? 'ts' : 'legacy'}`)
      return { text: 'we should ship', words: words('we should ship'), spokenWords: words('we should ship'), timestamps: !!opts.timestamps, model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' } as any
    }),
    parakeet: vi.fn(async (_wav: Buffer, opts: any) => {
      calls.push(`parakeet:${opts.model}:${opts.lane}:${opts.timeoutMs}`)
      return { model: opts.model, text: 'we should ship the build Friday', words: words('we should ship the build Friday'), processingSec: 0.1, wallMs: 100 }
    }),
    frontEnd: vi.fn(async (audio: Buffer, fe: string) => { calls.push(`fe:${fe}`); return audio }),
    vocabulary: () => [],
    ...over,
  }
  return { d, calls }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cos-batch-stt-'))
  process.env.COS_DATA_DIR = join(dir, 'data')
  delete process.env.COS_BATCH_HQ_TIMESTAMPS
  for (const i of [0, 1]) writeFileSync(join(dir, `chunk_000${i}.wav`), wav())
  vi.resetModules()
  M = await import('./meeting-batch-transcribe.js')
})
afterEach(() => { delete process.env.COS_DATA_DIR; rmSync(dir, { recursive: true, force: true }) })

const plan = (over: Partial<import('./meeting-batch-transcribe.js').HqJobPlan> = {}) => ({ engine: 'large-v3' as const, secondOpinion: 'parakeet-ultra' as const, resolver: true, frontEnd: 'highpass' as const, ...over })

describe('meeting HQ under the STT plan (6.72.0)', () => {
  it('large-v3 with timestamps, Parakeet second opinion on the same audio, resolver fills the gap', async () => {
    const { d, calls } = deps()
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan(), d)
    expect(calls).toEqual(['fe:highpass', 'whisper:ts', `parakeet:parakeet-ultra:batch:${M.PARAKEET_FIRST_WINDOW_TIMEOUT_MS}`])
    expect(d.parakeet.mock.calls[0][0]).toBe(d.whisper.mock.calls[0][0])
    expect(r.text).toBe('we should ship the build Friday')
    expect(r.words.map(w => w.word)).toEqual(['we', 'should', 'ship', 'the', 'build', 'Friday'])
    expect(r.speakerWords).toHaveLength(6)
    expect(r.stt).toMatchObject({ engine: 'large-v3', requestedEngine: 'large-v3', frontEnd: 'highpass', timestamps: true,
      primary: { engine: 'large-v3', text: 'we should ship' }, secondOpinion: { engine: 'parakeet-ultra', text: 'we should ship the build Friday' },
      resolver: { enabled: true, applied: true, wordsFromSecond: 3 } })
    expect(r.stt!.disagreements).toEqual([expect.objectContaining({ kind: 'second_only', taken: 'second', reason: 'gap_fill' })])
  })

  it('resolver off keeps the primary text but still saves both hypotheses and the disagreements', async () => {
    const { d } = deps()
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ resolver: false }), d)
    expect(r.text).toBe('we should ship')
    expect(r.stt).toMatchObject({ resolver: { enabled: false, applied: false, wordsFromSecond: 0 }, secondOpinion: { text: 'we should ship the build Friday' } })
    expect(r.stt!.disagreements[0]).toMatchObject({ taken: 'primary' })
  })

  it('a legacy (untimed) primary never has its words changed by the resolver', async () => {
    const { d, calls } = deps()
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ engine: 'large-v3-legacy' }), d)
    expect(calls[1]).toBe('whisper:legacy')
    expect(r.text).toBe('we should ship')
    expect(r.stt!.resolver.applied).toBe(false)
    expect(r.stt!.disagreements.length).toBe(1)
  })

  it('a failed second opinion leaves the primary exactly as heard', async () => {
    const { d } = deps({ parakeet: vi.fn(async () => { throw new Error('timeout') }) })
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan(), d)
    expect(r.text).toBe('we should ship')
    expect(r.stt!.secondOpinion).toMatchObject({ engine: 'parakeet-ultra', text: '', error: expect.stringContaining('timeout') })
    expect(r.stt!.disagreements).toEqual([])
  })

  it('a failed Parakeet primary falls back to Large-v3 for that window and says why', async () => {
    const { d, calls } = deps({ parakeet: vi.fn(async () => { throw new Error('cli exit 1') }) })
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ engine: 'parakeet-ultra', secondOpinion: 'large-v3' }), d)
    expect(calls).toContain('whisper:ts')
    expect(r.stt).toMatchObject({ engine: 'large-v3', requestedEngine: 'parakeet-ultra', fallbackReason: expect.stringContaining('parakeet_failed') })
    expect(r.stt!.secondOpinion).toBeUndefined() // the fallback is Whisper, so a Whisper second opinion would only repeat it
    expect(r.text).toBe('we should ship')
  })

  it('Parakeet primary: its words, no overlap strip, Large-v3 second opinion with a later shorter deadline', async () => {
    const { d, calls } = deps()
    const two = [segment, { ...segment, startChunkIdx: 1, endChunkIdx: 1 }]
    const out = await M.transcribeSegments(dir, two, entries, undefined, plan({ engine: 'parakeet-ultra', secondOpinion: 'large-v3' }), d)
    expect(out[0].stt).toMatchObject({ engine: 'parakeet-ultra', secondOpinion: { engine: 'large-v3' } })
    expect(out[0].text).toBe('we should ship the build Friday')
    expect(calls.filter(c => c.startsWith('parakeet'))).toEqual([
      `parakeet:parakeet-ultra:batch:${M.PARAKEET_FIRST_WINDOW_TIMEOUT_MS}`, `parakeet:parakeet-ultra:batch:${M.PARAKEET_WINDOW_TIMEOUT_MS}`])
  })

  it('second opinion off: one engine, no second decode, front end follows the plan', async () => {
    const { d, calls } = deps()
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ secondOpinion: 'off', frontEnd: 'full' }), d)
    expect(calls).toEqual(['fe:full', 'whisper:ts'])
    expect(r.stt!.secondOpinion).toBeUndefined()
  })

  it('the plan is frozen per job: a settings change mid-job does not switch engines', async () => {
    let n = 0
    const { d, calls } = deps({ frontEnd: vi.fn(async (audio: Buffer, fe: string) => {
      calls.push(`fe:${fe}`)
      if (n++ === 0) writeFileSync(join(dir, 'data', 'stt-settings.json'), JSON.stringify({ hq: 'large-v3-legacy', frontEnd: 'full', secondOpinion: 'off' }))
      return audio
    }) })
    const two = [segment, { ...segment, startChunkIdx: 1, endChunkIdx: 1 }]
    await M.transcribeSegments(dir, two, entries, undefined, plan(), d)
    expect(calls.filter(c => c.startsWith('fe:'))).toEqual(['fe:highpass', 'fe:highpass'])
    expect(calls.filter(c => c.startsWith('whisper'))).toEqual(['whisper:ts', 'whisper:ts'])
    expect(calls.filter(c => c.startsWith('parakeet'))).toHaveLength(2)
  })

  it('the job plan follows the stored settings and what is installed', async () => {
    writeFileSync(join(dir, 'data', 'stt-settings.json'), JSON.stringify({ hq: 'large-v3', secondOpinion: 'parakeet-ultra', resolver: true, frontEnd: 'full' }))
    // Parakeet is not installed in this data dir, so the planned second opinion is off.
    expect(M.currentHqJobPlan()).toEqual({ engine: 'large-v3', secondOpinion: 'off', resolver: false, frontEnd: 'full' })
  })

  it('summarizes the plan and the disagreements for the sidecar', async () => {
    const { d } = deps()
    const out = await M.transcribeSegments(dir, [segment], entries, undefined, plan(), d)
    expect(M.summarizeStt(plan(), out)).toMatchObject({ plan: { engine: 'large-v3', timestamps: true }, windows: 1, disagreements: 1, wordsFromSecond: 3, secondOpinionFailures: 0, primaryFallbacks: 0 })
  })
})
