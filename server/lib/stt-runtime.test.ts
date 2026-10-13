import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveStt } from './stt-settings.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-stt-runtime-')); process.env.COS_DATA_DIR = dir; vi.resetModules() })
afterEach(() => { delete process.env.COS_DATA_DIR; rmSync(dir, { recursive: true, force: true }) })

const eff = (engine: 'turbo' | 'parakeet', selected: string = engine, frontEnd: 'highpass' | 'full' = 'highpass'): EffectiveStt => ({
  settings: { preview: selected as any, hq: 'large-v3', secondOpinion: 'parakeet-ultra', resolver: true, frontEnd, quietGate: 'silero' },
  preview: { engine, reason: null }, hq: { engine: 'large-v3', reason: null }, secondOpinion: { engine: 'parakeet-ultra', reason: null },
  resolver: true, frontEnd, quietGate: 'silero',
})
const PHONE_639 = ['large-v3-turbo', 'parakeet-ultra', 'large-v3']

function deps(engine: 'turbo' | 'parakeet', over: Record<string, unknown> = {}) {
  const seen: string[] = []
  return {
    seen,
    d: {
      effective: () => eff(engine),
      turbo: vi.fn(async (a: Buffer) => { seen.push(`turbo:${a}`); return { text: 'turbo text', model: 'large-v3-turbo', backend: 'whisper-preview-server' } }),
      parakeet: vi.fn(async (a: Buffer) => { seen.push(`parakeet:${a}`); return { text: 'parakeet text' } }),
      frontEnd: vi.fn(async (a: Buffer, fe: string) => Buffer.from(`${fe}(${a})`)),
      now: () => 0,
      ...over,
    } as any,
  }
}

describe('meeting preview dispatch (6.72.0)', () => {
  it('turbo is the default engine and hears the raw audio, as before 6.72', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    const { d, seen } = deps('turbo')
    expect(await transcribeMeetingPreview(Buffer.from('a'), PHONE_639, d)).toEqual({ text: 'turbo text', model: 'large-v3-turbo', backend: 'whisper-preview-server' })
    expect(seen).toEqual(['turbo:a'])
  })

  it('parakeet when warm and the client accepts it; it hears the selected front end', async () => {
    const { transcribeMeetingPreview, PREVIEW_PARAKEET_MODEL } = await import('./stt-runtime.js')
    const ok = deps('parakeet')
    expect(await transcribeMeetingPreview(Buffer.from('a'), PHONE_639, ok.d)).toEqual({ text: 'parakeet text', model: PREVIEW_PARAKEET_MODEL, backend: 'fluidaudio-coreml' })
    expect(ok.seen).toEqual(['parakeet:highpass(a)'])
    const full = deps('parakeet', { effective: () => eff('parakeet', 'parakeet', 'full') })
    await transcribeMeetingPreview(Buffer.from('a'), PHONE_639, full.d)
    expect(full.seen).toEqual(['parakeet:full(a)'])
  })

  it('a client that lists no preview models (phones before 6.10.639) always gets Turbo', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    for (const accepted of [[], ['large-v3-turbo']]) {
      const { d, seen } = deps('parakeet')
      expect(await transcribeMeetingPreview(Buffer.from('a'), accepted, d)).toMatchObject({ model: 'large-v3-turbo' })
      expect(seen).toEqual(['turbo:a'])
    }
  })

  it('a Parakeet miss falls back to Turbo only inside the phone budget', async () => {
    const { transcribeMeetingPreview, PREVIEW_TURBO_FALLBACK_BEFORE_MS } = await import('./stt-runtime.js')
    const fast = deps('parakeet', { parakeet: vi.fn(async () => { throw new Error('cli exit 1') }) })
    expect((await transcribeMeetingPreview(Buffer.from('a'), PHONE_639, fast.d))!.text).toBe('turbo text')
    let t = 0
    const slow = deps('parakeet', { parakeet: vi.fn(async () => { t = PREVIEW_TURBO_FALLBACK_BEFORE_MS; throw new Error('timeout') }), now: () => t })
    expect(await transcribeMeetingPreview(Buffer.from('a'), PHONE_639, slow.d)).toBeNull()
    expect(slow.seen).toEqual([])
  })

  it('repeated misses open a breaker; a busy lane does not count', async () => {
    const R = await import('./stt-runtime.js')
    R.__resetPreviewForTests()
    const busy = deps('parakeet', { parakeet: vi.fn(async () => { throw Object.assign(new Error('busy'), { reason: 'busy' }) }) })
    for (let i = 0; i < 5; i++) await R.transcribeMeetingPreview(Buffer.from('a'), PHONE_639, busy.d)
    expect(R.previewBreakerState().open).toBe(false)
    const bad = deps('parakeet', { parakeet: vi.fn(async () => { throw new Error('cli exit 1') }) })
    for (let i = 0; i < R.PREVIEW_BREAKER_MISSES; i++) await R.transcribeMeetingPreview(Buffer.from('a'), PHONE_639, bad.d)
    expect(R.previewBreakerState().open).toBe(true)
    expect(R.previewCounters()).toMatchObject({ parakeetMisses: R.PREVIEW_BREAKER_MISSES, turboFallbacks: 5 + R.PREVIEW_BREAKER_MISSES })
  })

  it('selected but still warming: Turbo previews, Parakeet is never called', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    const { d, seen } = deps('turbo')
    d.effective = () => ({ ...eff('turbo', 'parakeet'), preview: { engine: 'turbo', reason: 'parakeet_warming' } })
    expect((await transcribeMeetingPreview(Buffer.from('a'), PHONE_639, d))!.text).toBe('turbo text')
    expect(seen).toEqual(['turbo:a'])
  })

  it('unreadable settings never cost the preview: Turbo', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    const { d } = deps('parakeet', { effective: () => { throw new Error('boom') } })
    expect((await transcribeMeetingPreview(Buffer.from('a'), PHONE_639, d))!.text).toBe('turbo text')
  })

  it('the server returns only the pinned preview model strings, all accepted by phone 6.10.639', async () => {
    const { PREVIEW_MODEL_STRINGS } = await import('./stt-settings.js')
    const { PREVIEW_PARAKEET_MODEL } = await import('./stt-runtime.js')
    expect([...PREVIEW_MODEL_STRINGS]).toEqual(['large-v3-turbo', 'parakeet-ultra'])
    expect(PREVIEW_MODEL_STRINGS).toContain(PREVIEW_PARAKEET_MODEL)
    for (const m of PREVIEW_MODEL_STRINGS) expect(PHONE_639).toContain(m)
  })
})

describe('preview warm-up scheduling', () => {
  it('defers while a recording is live, and throttles a failed warm-up', async () => {
    vi.doMock('./parakeet.js', async (orig) => {
      const real: any = await orig()
      let state: any = { state: 'cold', at: 0 }
      return { ...real, parakeetInstalled: () => ({ installed: true, bytes: 1 }), parakeetWarmState: () => state,
        warmParakeet: vi.fn(async () => { state = { state: 'failed', at: Date.now(), error: 'x' }; return false }), __setWarm: (s: any) => { state = s } }
    })
    writeFileSync(join(dir, 'stt-settings.json'), JSON.stringify({ preview: 'parakeet' }))
    const R = await import('./stt-runtime.js')
    const P: any = await import('./parakeet.js')
    R.setRecordingLiveProbe(() => true)
    expect(R.ensurePreviewWarm()).toBe('deferred')
    expect(P.warmParakeet).not.toHaveBeenCalled()
    R.setRecordingLiveProbe(() => false)
    expect(R.ensurePreviewWarm()).toBe('started')
    await Promise.resolve(); await Promise.resolve()
    expect(R.ensurePreviewWarm()).toBe('skipped') // failed moments ago: throttled
    expect(R.ensurePreviewWarm(Date.now() + R.WARM_RETRY_MS + 1)).toBe('started')
    vi.doUnmock('./parakeet.js')
    R.__resetPreviewForTests()
  })
})

describe('sidecar keeps both hypotheses (additive)', () => {
  it('writes segment stt and the meeting summary, and drops them when the batch is rejected', async () => {
    const { persistBatchDecisionSidecar } = await import('./meeting-batch-persistence.js')
    const path = join(dir, 'm.json')
    writeFileSync(path, JSON.stringify({ sessionId: 's', keep: 1 }))
    const stt = { engine: 'large-v3', requestedEngine: 'large-v3', frontEnd: 'highpass', timestamps: true, primary: { engine: 'large-v3', text: 'a' },
      secondOpinion: { engine: 'parakeet-ultra', text: 'a b' }, resolver: { version: 'v', enabled: true, applied: true, wordsFromSecond: 1 }, disagreements: [] }
    const result: any = { transcriptionQuality: 'batch', batchTranscript: 'a b', batchSegments: [{ segment: { startChunkIdx: 0, endChunkIdx: 0, startElapsed: 0, endElapsed: 0, speakers: [] }, text: 'a b', words: [], speakerWords: [], stt }],
      stt: { plan: { engine: 'large-v3' }, windows: 1 } }
    expect(persistBatchDecisionSidecar(path, result, true)).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.keep).toBe(1)
    expect(saved.batchSegments[0].stt).toEqual(stt)
    expect(saved.stt).toEqual({ plan: { engine: 'large-v3' }, windows: 1 })
    persistBatchDecisionSidecar(path, result, false)
    expect(JSON.parse(readFileSync(path, 'utf8')).stt).toBeUndefined()
  })
})

describe('HQ checkpoint identity (6.72.0)', () => {
  it('differs by front end and by timestamps, so a checkpoint is never reused across settings', async () => {
    const { getHighQualityCheckpointFingerprint } = await import('./whisper-local.js')
    const a = getHighQualityCheckpointFingerprint({ timestamps: false, frontEnd: 'full' })
    expect(getHighQualityCheckpointFingerprint({ timestamps: false, frontEnd: 'highpass' })).not.toBe(a)
    expect(getHighQualityCheckpointFingerprint({ timestamps: true, frontEnd: 'full' })).not.toBe(a)
    expect(getHighQualityCheckpointFingerprint({ timestamps: false, frontEnd: 'full' })).toBe(a)
  })
})

describe('orphan recovery keeps the hypotheses', () => {
  it('adds the stt summary and per-window records to the recovered sidecar, keeping every other field', async () => {
    const { persistSttSidecar } = await import('./meeting-batch-persistence.js')
    const path = join(dir, 'r.g2-chunks.json')
    writeFileSync(path, JSON.stringify({ sessionId: 's', chunks: [1] }))
    const stt: any = { engine: 'large-v3', requestedEngine: 'large-v3', frontEnd: 'highpass', timestamps: true, primary: { engine: 'large-v3', text: 'a' }, resolver: { version: 'v', enabled: true, applied: false, wordsFromSecond: 0 }, disagreements: [] }
    const results: any[] = [{ segment: { startChunkIdx: 0, endChunkIdx: 5 }, text: 'a', words: [], speakerWords: [], stt }, { segment: { startChunkIdx: 6, endChunkIdx: 9 }, text: 'b', words: [], speakerWords: [] }]
    expect(persistSttSidecar(path, results, { windows: 2 } as any)).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).toMatchObject({ sessionId: 's', chunks: [1], stt: { windows: 2 }, sttSegments: [{ startChunkIdx: 0, endChunkIdx: 5, stt }] })
    expect(saved.batchApplied).toBeUndefined()
    expect(persistSttSidecar(join(dir, 'missing.json'), results, {} as any)).toBe(false)
  })
})

describe('Parakeet install offer', () => {
  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('is never offered without the pinned CLI build on this Mac', async () => {
    const prior = process.env.HOME
    process.env.HOME = dir
    try {
      const R = await import('./stt-runtime.js')
      const P = await import('./parakeet.js')
      await P.findPinnedCli() // nothing at ~/.cos-glasses/bin under this HOME
      const status = R.parakeetStatus(false)
      expect(status.installable).toBe(false)
      expect(status.note).toMatch(/fluidaudiocli 0\.17\.4/)
    } finally { process.env.HOME = prior }
  })
})

