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
      return { text: 'we should ship', words: words('we should ship'), spokenWords: words('we should ship'), timestamps: !!opts.timestamps,
        ...(opts.timestamps ? { speechSpans: [[0, 10]] } : {}), model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' } as any
    }),
    parakeet: vi.fn(async (_wav: Buffer, opts: any) => {
      calls.push(`parakeet:${opts.model}:${opts.lane}:${opts.timeoutMs}`)
      return { model: opts.model, text: 'we should ship the build Friday', words: words('we should ship the build Friday'), processingSec: 0.1, wallMs: 100 }
    }),
    frontEnd: vi.fn(async (audio: Buffer, fe: string) => { calls.push(`fe:${fe}`); return audio }),
    vocabulary: () => [],
    speechSeconds: () => 3,
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

const plan = (over: Partial<import('./meeting-batch-transcribe.js').HqJobPlan> = {}): import('./meeting-batch-transcribe.js').HqJobPlan => ({ engine: 'large-v3', secondOpinion: 'parakeet-ultra', resolver: true, frontEnd: 'highpass', ...over })

describe('meeting HQ under the STT plan (6.72.0)', () => {
  it('large-v3 with timestamps, Parakeet second opinion on the same audio, resolver fills the gap', async () => {
    const { d, calls } = deps()
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ secondOpinion: 'parakeet-ultra' }), d)
    expect(calls).toEqual(['fe:highpass', 'whisper:ts', `parakeet:parakeet-ultra:batch:${M.PARAKEET_FIRST_WINDOW_TIMEOUT_MS}`])
    expect((d.parakeet as any).mock.calls[0][0]).toBe((d.whisper as any).mock.calls[0][0])
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
    expect(M.summarizeStt(plan(), out, 2)).toMatchObject({ plan: { engine: 'large-v3', timestamps: true }, windows: 1, windowsLost: 1, disagreements: 1, wordsFromSecond: 3, secondOpinionFailures: 0, primaryFallbacks: 0, timestampFallbacks: 0, checkpointsReused: 0 })
  })

  it('a timestamp decode that fails is retried with the legacy decoder; the window keeps its text', async () => {
    const { d, calls } = deps({ whisper: vi.fn(async (_w: Buffer, _c: any, opts: any) => {
      calls.push(`whisper:${opts.timestamps ? 'ts' : 'legacy'}`)
      if (opts.timestamps) throw new Error('HQ VAD timing evidence inconsistent')
      return { text: 'legacy text', words: words('legacy text'), timestamps: false, model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' } as any
    }) })
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ secondOpinion: 'off' }), d)
    expect(calls).toEqual(['fe:highpass', 'whisper:ts', 'whisper:legacy'])
    expect(r.text).toBe('legacy text')
    expect(r.stt).toMatchObject({ engine: 'large-v3-legacy', timestamps: false, fallbackReason: expect.stringContaining('timestamps_failed') })
    expect(M.summarizeStt(plan(), [r]).timestampFallbacks).toBe(1)
  })

  it('Whisper failing both ways: the planned Parakeet second opinion becomes the primary', async () => {
    const { d } = deps({ whisper: vi.fn(async () => { throw new Error('whisper-cli HQ exit 1') }) })
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ secondOpinion: 'parakeet-ultra' }), d)
    expect(r.text).toBe('we should ship the build Friday')
    expect(r.stt).toMatchObject({ engine: 'parakeet-ultra', fallbackReason: expect.stringContaining('whisper_failed') })
    expect(r.stt!.secondOpinion).toBeUndefined()
  })

  it('an empty Parakeet primary over audio with speech is a failure: Large-v3 decodes the window', async () => {
    const { d, calls } = deps({ parakeet: vi.fn(async (_w: Buffer, opts: any) => { calls.push('parakeet'); return { model: opts.model, text: '', words: [], processingSec: 0.1, wallMs: 10 } }) })
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ engine: 'parakeet-ultra', secondOpinion: 'off' }), d)
    expect(calls).toContain('whisper:ts')
    expect(r.stt).toMatchObject({ engine: 'large-v3', fallbackReason: expect.stringContaining('no words over 3.0 s of speech') })
    // Silence really is silence: an empty Parakeet window stands.
    const quiet = deps({ speechSeconds: () => 0.1, parakeet: vi.fn(async (_w: Buffer, opts: any) => ({ model: opts.model, text: '', words: [], processingSec: 0.1, wallMs: 10 })) })
    const [q] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ engine: 'parakeet-ultra', secondOpinion: 'off' }), quiet.d)
    expect(q.stt).toMatchObject({ engine: 'parakeet-ultra' })
    expect(q.text).toBe('')
  })

  it('Parakeet is not called again in a job after two failures in a row', async () => {
    let n = 0
    const { d } = deps({ parakeet: vi.fn(async () => { n++; throw new Error('timeout') }) })
    const three = [segment, { ...segment, startChunkIdx: 1, endChunkIdx: 1 }, { ...segment, startChunkIdx: 0, endChunkIdx: 0 }]
    const out = await M.transcribeSegments(dir, three, entries, undefined, plan({ secondOpinion: 'parakeet-ultra' }), d)
    expect(n).toBe(M.PARAKEET_JOB_BREAKER_FAILURES)
    expect(out).toHaveLength(3)
    expect(out[2].stt!.secondOpinion).toMatchObject({ error: expect.stringContaining('stopped for this job') })
    expect(out.every(r => r.text === 'we should ship')).toBe(true)
  })

  it('records a skipped (too long) resolution and never claims second-opinion words it did not apply', async () => {
    const { d } = deps({ whisper: vi.fn(async (_w: Buffer, _c: any, opts: any) => ({ text: 'we should ship', words: words('we should ship'), timestamps: !!opts.timestamps, model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' }) as any) })
    // No spoken words from Whisper: the resolver records but may not apply.
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan(), d)
    expect(r.stt!.resolver.applied).toBe(false)
    expect(r.stt!.disagreements.every(x => x.taken === 'primary')).toBe(true)
  })
})

describe('progressive checkpoints under a second opinion', () => {
  it('reuse the checkpoint as the primary and decode only the second opinion', async () => {
    process.env.COS_MEETING_PROGRESSIVE_HQ = '1'
    try {
      vi.resetModules()
      vi.doMock('./whisper-local.js', async (orig) => ({ ...(await orig() as any), getHighQualityTranscriptionCapability: () => ({ hqAvailable: true, model: 'large-v3', backend: 'whisper-cli', reason: null }) }))
      const MM = await import('./meeting-batch-transcribe.js')
      const id = { timestamps: true, frontEnd: 'highpass' as const }
      const { getHighQualityCheckpointFingerprint } = await import('./whisper-local.js')
      MM.__progressiveHqTesting.writeProgressiveCheckpoint(dir, 's1', {
        key: '0-1', sourceHash: MM.__progressiveHqTesting.segmentSourceHash(dir, segment)!, contextHash: MM.__progressiveHqTesting.contextHash(undefined),
        configFingerprint: getHighQualityCheckpointFingerprint(id), completedAt: new Date().toISOString(), wallTimeMs: 1,
        result: { segment, text: 'we should ship', words: words('we should ship'), spokenWords: words('we should ship'), speechSpans: [[0, 10]],
          speakerWords: words('we should ship').map(w => ({ ...w, speaker: 'MU', similarity: 1 })) } as any,
      })
      const { d, calls } = deps()
      const [r] = await MM.transcribeSegments(dir, [segment], entries, 's1', plan({ secondOpinion: 'parakeet-ultra' }), d)
      expect(calls.filter(c => c.startsWith('whisper'))).toEqual([])
      expect(calls.filter(c => c.startsWith('parakeet'))).toHaveLength(1)
      expect(r.stt).toMatchObject({ reusedCheckpoint: true, resolver: { applied: true } })
      expect(r.text).toBe('we should ship the build Friday')
      const off = deps()
      const [o] = await MM.transcribeSegments(dir, [segment], entries, 's1', plan({ secondOpinion: 'off' }), off.d)
      expect(off.calls).toEqual([])
      expect(o.stt).toMatchObject({ reusedCheckpoint: true })
      // A Parakeet HQ plan never takes a Whisper checkpoint.
      const pk = deps()
      await MM.transcribeSegments(dir, [segment], entries, 's1', plan({ engine: 'parakeet-ultra', secondOpinion: 'off' }), pk.d)
      expect(pk.calls.some(c => c.startsWith('parakeet'))).toBe(true)
    } finally {
      delete process.env.COS_MEETING_PROGRESSIVE_HQ
      vi.doUnmock('./whisper-local.js')
    }
  })
})


describe('the plan the production call sites use', () => {
  it('runMeetingBatchPipeline freezes the stored settings at save time and records the job', async () => {
    vi.resetModules()
    const seen: any[] = []
    vi.doMock('./whisper-local.js', async (orig) => ({ ...(await orig() as any),
      transcribeHighQuality: vi.fn(async (_w: Buffer, _c: any, opts: any) => { seen.push(opts); return { text: 'hello there friend', words: words('hello there friend'), spokenWords: words('hello there friend'), timestamps: !!opts.timestamps, model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' } }) }))
    vi.doMock('./stt-live.js', async (orig) => ({ ...(await orig() as any), asrFrontEnd: async (a: Buffer) => a }))
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(dir, 'data'), { recursive: true })
      writeFileSync(join(dir, 'data', 'stt-settings.json'), JSON.stringify({ hq: 'large-v3', secondOpinion: 'off', frontEnd: 'highpass' }))
      const MM = await import('./meeting-batch-transcribe.js')
      const job = MM.runMeetingBatchPipeline(dir, entries, 3, 's1')
      // A change after the save must not reach this job.
      writeFileSync(join(dir, 'data', 'stt-settings.json'), JSON.stringify({ hq: 'large-v3-legacy', secondOpinion: 'off', frontEnd: 'full' }))
      const out = await job
      expect(out.stt?.plan).toMatchObject({ engine: 'large-v3', frontEnd: 'highpass', timestamps: true })
      expect(seen.every(o => o.timestamps === true)).toBe(true)
      const { readLastSttJob } = await import('./stt-settings.js')
      expect(readLastSttJob()).toMatchObject({ outcome: 'batch', summary: { plan: { engine: 'large-v3' } } })
    } finally {
      vi.doUnmock('./whisper-local.js'); vi.doUnmock('./stt-live.js')
    }
  })

  it('orphan recovery takes the stored plan once and decodes with it', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 'stt-settings.json'), JSON.stringify({ hq: 'large-v3', secondOpinion: 'off', frontEnd: 'highpass' }))
    vi.resetModules()
    const MM = await import('./meeting-batch-transcribe.js')
    const { d, calls } = deps()
    const job = MM.recoveryHqJob(dir, [segment], entries, d)
    expect(job.plan).toMatchObject({ engine: 'large-v3', frontEnd: 'highpass', secondOpinion: 'off' })
    writeFileSync(join(dir, 'data', 'stt-settings.json'), JSON.stringify({ hq: 'large-v3-legacy', frontEnd: 'full' }))
    const [r] = await job.run()
    expect(calls).toEqual(['fe:highpass', 'whisper:ts'])
    expect(r.stt).toMatchObject({ engine: 'large-v3', frontEnd: 'highpass' })
  })
})

describe('what the resolver saves', () => {
  it('a rescue the resolver cannot apply (untimed second opinion) is saved as kept, not taken', async () => {
    const { d } = deps({
      whisper: vi.fn(async () => ({ text: 'we sell ThriftCart now', words: words('we sell ThriftCart now'), timestamps: false, model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' }) as any),
      parakeet: vi.fn(async (_w: Buffer, opts: any) => ({ model: opts.model, text: 'we sell drift card now', words: words('we sell drift card now'), processingSec: 0.1, wallMs: 10 })),
      vocabulary: () => ['ThriftCart'],
    })
    const [r] = await M.transcribeSegments(dir, [segment], entries, undefined, plan({ engine: 'parakeet-ultra', secondOpinion: 'large-v3' }), d)
    expect(r.text).toBe('we sell drift card now')
    expect(r.stt!.resolver.applied).toBe(false)
    expect(r.stt!.disagreements.length).toBeGreaterThan(0)
    expect(r.stt!.disagreements.every(x => x.taken === 'primary')).toBe(true)
  })

  it('applies name corrections once, to the joined text (a two-word correction works, nothing doubles)', async () => {
    const profile = join(dir, 'profile.json')
    writeFileSync(profile, JSON.stringify({ whisper_corrections: JSON.stringify({ 'drift card': 'ThriftCart' }) }))
    const prior = process.env.COS_PROFILE_PATH
    process.env.COS_PROFILE_PATH = profile
    try {
      vi.resetModules()
      const MM = await import('./meeting-batch-transcribe.js')
      const { d } = deps({ parakeet: vi.fn(async (_w: Buffer, opts: any) => ({ model: opts.model, text: 'we should ship the drift card build', words: words('we should ship the drift card build'), processingSec: 0.1, wallMs: 10 })) })
      const [r] = await MM.transcribeSegments(dir, [segment], entries, undefined, plan({ secondOpinion: 'parakeet-ultra' }), d)
      expect(r.stt!.resolver.applied).toBe(true)
      expect(r.text).toBe('we should ship the ThriftCart build')
    } finally {
      if (prior === undefined) delete process.env.COS_PROFILE_PATH; else process.env.COS_PROFILE_PATH = prior
    }
  })
})

describe('strict Mac Parakeet saved HQ',()=>{
 const macId='mac_abcdef01-2345-6789-abcd-0123456789ab'
 it('preserves a selected but unavailable Parakeet HQ plan for Mac; G2 retains its existing fallback',async()=>{
  const stt=await import('./stt-settings.js')
  stt.writeSttSettings({...stt.readSttSettings(),hq:'parakeet-ultra',secondOpinion:'off',resolver:false})
  expect(M.currentHqJobPlan(macId)).toMatchObject({engine:'parakeet-ultra',strictPrimary:true,secondOpinion:'off'})
  expect(M.currentHqJobPlan('g2_legacy').engine).toBe('large-v3')
  const {d}=deps()
  expect(M.recoveryHqJob(dir,[segment],entries,d,macId).plan).toMatchObject({engine:'parakeet-ultra',strictPrimary:true})
 })
 it('rejects the whole Mac HQ candidate on primary failure instead of replacing canonical Parakeet with Whisper',async()=>{
  const {d}=deps({parakeet:vi.fn(async()=>{throw new Error('selected Parakeet unavailable')})})
  await expect(M.transcribeSegments(dir,[segment],entries,macId,plan({engine:'parakeet-ultra',secondOpinion:'off'}),d)).rejects.toThrow('audio is preserved for retry')
  expect(d.whisper).not.toHaveBeenCalled()
 })
 it('does not accept a partial Mac HQ candidate when a later Parakeet window fails',async()=>{
  const {d}=deps();vi.mocked(d.parakeet).mockImplementationOnce(async(_wav,opts)=>({model:opts.model,text:'we should ship',words:words('we should ship'),processingSec:0.1,wallMs:100})).mockRejectedValueOnce(new Error('busy'))
  await expect(M.transcribeSegments(dir,[segment,{...segment,startChunkIdx:1}],entries,macId,plan({engine:'parakeet-ultra',secondOpinion:'off'}),d)).rejects.toThrow()
  expect(d.whisper).not.toHaveBeenCalled()
 })
})

it('surfaces selected Mac HQ failure to durable finalization while preserving the canonical chunk evidence and WAVs',async()=>{
 vi.resetModules()
 const {ParakeetError}=await import('./parakeet.js')
 const whisper=vi.fn(),parakeet=vi.fn(async()=>{throw new ParakeetError('busy','batch occupied')})
 vi.doMock('./parakeet.js',async original=>({...await original<typeof import('./parakeet.js')>(),transcribeParakeet:parakeet}))
 vi.doMock('./whisper-local.js',async original=>({...await original<typeof import('./whisper-local.js')>(),transcribeHighQuality:whisper}))
 vi.doMock('./stt-live.js',async original=>({...await original<typeof import('./stt-live.js')>(),asrFrontEnd:async(b:Buffer)=>b}))
 try {
  const stt=await import('./stt-settings.js');stt.writeSttSettings({...stt.readSttSettings(),hq:'parakeet-ultra',secondOpinion:'off',resolver:false})
  const MM=await import('./meeting-batch-transcribe.js')
  const before=JSON.stringify(entries)
  await expect(MM.runMeetingBatchPipeline(dir,entries,3,'mac_abcdef01-2345-6789-abcd-0123456789ab')).rejects.toMatchObject({reason:'mac_parakeet_busy',retryable:true})
  expect(JSON.stringify(entries)).toBe(before);expect(whisper).not.toHaveBeenCalled()
  const fs=await import('node:fs');expect(fs.existsSync(join(dir,'chunk_0000.wav'))).toBe(true)
  expect(JSON.parse(fs.readFileSync(join(dir,'_batch_terminal.json'),'utf8'))).toMatchObject({outcome:'failed',reason:expect.stringContaining('audio is preserved for retry')})
 } finally {vi.doUnmock('./parakeet.js');vi.doUnmock('./whisper-local.js');vi.doUnmock('./stt-live.js')}
})

describe('6.83.1: the decoder window for the next segment', () => {
  it('puts a dictionary link back to speech before the 250-character cut', async () => {
    const { writeFileSync: write } = await import('node:fs')
    write(process.env.COS_PROFILE_PATH!, JSON.stringify({ vocabulary: ['Quilt'], whisper_corrections: JSON.stringify({ 'sam at example dot com': 'sam@example.com' }) }))
    const profile = await import('./profile.js')
    const whisper = await import('./whisper-local.js')
    profile.clearProfileCache(); whisper.resetDecoderCaches()
    try {
      // The first segment's corrected text holds the link where the raw 250-character cut splits it.
      const first = `${'word '.repeat(60)}mail sam@example.com ${'tail '.repeat(48)}`.trim()
      const seen: Array<string | undefined> = []
      const { d } = deps({ whisper: vi.fn(async (_w: Buffer, ctx: string | undefined, opts: any) => {
        seen.push(ctx)
        const text = seen.length === 1 ? first : 'next part'
        return { text, words: words(text), timestamps: !!opts.timestamps, model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' } as any
      }) })
      const segs = [0, 1].map(i => ({ startChunkIdx: i, endChunkIdx: i, startElapsed: i * 6_000, endElapsed: (i + 1) * 6_000, speakers: ['MU'] }))
      const results = await M.transcribeSegments(dir, segs, entries, undefined, plan({ secondOpinion: 'none' as any }), d)
      expect(results[0].text).toContain('sam@example.com')
      expect(first.slice(-250)).toMatch(/^[^ ]*\.com/)
      const ctx = seen[1] ?? ''
      expect(ctx.length).toBeGreaterThan(0)
      expect(ctx).not.toContain('@')
      expect(ctx).not.toContain('.com')
      expect(ctx).toContain('dot com')
    } finally {
      const { rmSync: rm } = await import('node:fs')
      rm(process.env.COS_PROFILE_PATH!, { force: true })
      profile.clearProfileCache(); whisper.resetDecoderCaches()
    }
  })
})
