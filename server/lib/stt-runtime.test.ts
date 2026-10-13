import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveStt } from './stt-settings.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-stt-runtime-')); process.env.COS_DATA_DIR = dir; vi.resetModules() })
afterEach(() => { delete process.env.COS_DATA_DIR; rmSync(dir, { recursive: true, force: true }) })

const eff = (engine: 'turbo' | 'large-v3' | 'parakeet', selected = engine): EffectiveStt => ({
  settings: { preview: selected as any, hq: 'large-v3', secondOpinion: 'parakeet-ultra', resolver: true, frontEnd: 'highpass', quietGate: 'silero' },
  preview: { engine, reason: null }, hq: { engine: 'large-v3', reason: null }, secondOpinion: { engine: 'parakeet-ultra', reason: null },
  resolver: true, frontEnd: 'highpass', quietGate: 'silero',
})

function deps(engine: 'turbo' | 'large-v3' | 'parakeet', over: Record<string, unknown> = {}) {
  const seen: string[] = []
  return {
    seen,
    d: {
      effective: () => eff(engine),
      turbo: vi.fn(async (a: Buffer) => { seen.push(`turbo:${a}`); return { text: 'turbo text', model: 'large-v3-turbo', backend: 'whisper-preview-server' } }),
      largeV3: vi.fn(async (a: Buffer) => { seen.push(`large:${a}`); return { text: 'large text' } }),
      parakeet: vi.fn(async (a: Buffer) => { seen.push(`parakeet:${a}`); return { text: 'parakeet text' } }),
      frontEnd: vi.fn(async (a: Buffer) => Buffer.from(`hp(${a})`)),
      ...over,
    } as any,
  }
}

describe('meeting preview dispatch (6.72.0)', () => {
  it('turbo is the default engine and hears the highpass audio', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    const { d, seen } = deps('turbo')
    expect(await transcribeMeetingPreview(Buffer.from('a'), d)).toEqual({ text: 'turbo text', model: 'large-v3-turbo', backend: 'whisper-preview-server' })
    expect(seen).toEqual(['turbo:hp(a)'])
  })

  it('parakeet when warm; any Parakeet failure is a Turbo preview for that request', async () => {
    const { transcribeMeetingPreview, PREVIEW_PARAKEET_MODEL } = await import('./stt-runtime.js')
    const ok = deps('parakeet')
    expect(await transcribeMeetingPreview(Buffer.from('a'), ok.d)).toEqual({ text: 'parakeet text', model: PREVIEW_PARAKEET_MODEL, backend: 'fluidaudio-coreml' })
    expect(ok.seen).toEqual(['parakeet:hp(a)'])
    const bad = deps('parakeet', { parakeet: vi.fn(async () => { throw new Error('busy') }) })
    expect((await transcribeMeetingPreview(Buffer.from('a'), bad.d))!.text).toBe('turbo text')
  })

  it('large-v3 preview uses the live worker; a contended request is a quiet miss', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    const ok = deps('large-v3')
    expect(await transcribeMeetingPreview(Buffer.from('a'), ok.d)).toEqual({ text: 'large text', model: 'large-v3', backend: 'whisper-server' })
    const miss = deps('large-v3', { largeV3: vi.fn(async () => null) })
    expect(await transcribeMeetingPreview(Buffer.from('a'), miss.d)).toBeNull()
    const broken = deps('large-v3', { largeV3: vi.fn(async () => { throw new Error('down') }) })
    expect((await transcribeMeetingPreview(Buffer.from('a'), broken.d))!.text).toBe('turbo text')
  })

  it('selected but still warming: Turbo previews, Parakeet is never called', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    const { d, seen } = deps('turbo')
    d.effective = () => ({ ...eff('turbo', 'parakeet'), preview: { engine: 'turbo', reason: 'parakeet_warming' } })
    expect((await transcribeMeetingPreview(Buffer.from('a'), d))!.text).toBe('turbo text')
    expect(seen).toEqual(['turbo:hp(a)'])
  })

  it('unreadable settings never cost the preview: Turbo', async () => {
    const { transcribeMeetingPreview } = await import('./stt-runtime.js')
    const { d } = deps('parakeet', { effective: () => { throw new Error('boom') } })
    expect((await transcribeMeetingPreview(Buffer.from('a'), d))!.text).toBe('turbo text')
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
