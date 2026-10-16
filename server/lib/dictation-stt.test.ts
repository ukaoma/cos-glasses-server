// 6.73.0: prompts and dictation follow the STT settings (docs/dictation-stt-contract.md).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STT_SETTINGS, dictationPlan, dictationSlotForMode, dictationView, legacyDictationKey, settingsView,
  type DictationPlan, type SttCapabilities, type SttSettings,
} from './stt-settings.js'

const caps = (over: Partial<SttCapabilities> = {}): SttCapabilities => ({
  turboModel: true, liveLargeV3: true, hqLargeV3: true, parakeetInstalled: true,
  parakeetPreviewWarm: true, parakeetPreviewWarming: false, parakeetPreviewWarmFailed: false,
  parakeetPreviewBreakerOpen: false, previewDisabledByEnv: false, ...over,
})
const settings = (over: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...over })

/** 16 kHz mono PCM16 WAV of `seconds` of a quiet tone. */
function wav(seconds = 1): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * 16_000) * 2)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(800 * Math.sin(i / 8)), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24)
  h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

describe('dictation mapping (pure)', () => {
  it('Fast mode follows the Preview model; Fast mode off follows the HQ model', () => {
    expect(dictationSlotForMode('fast')).toBe('fast')
    expect(dictationSlotForMode('hq')).toBe('final')
    const s = settings({ preview: 'parakeet', hq: 'large-v3' })
    expect(dictationPlan('fast', s, caps())).toMatchObject({ engine: 'parakeet-ultra', reason: null, key: 'fast:parakeet' })
    expect(dictationPlan('preview', s, caps())).toMatchObject({ engine: 'parakeet-ultra', key: 'preview:parakeet' })
    expect(dictationPlan('final', s, caps())).toMatchObject({ engine: 'whisper', reason: null, key: 'final:large-v3' })
    const h = settings({ preview: 'turbo', hq: 'parakeet-ultra' })
    expect(dictationPlan('final', h, caps())).toMatchObject({ engine: 'parakeet-ultra', key: 'final:parakeet-ultra' })
    expect(dictationPlan('fast', h, caps())).toMatchObject({ engine: 'whisper', reason: null, key: 'fast:turbo' })
  })

  it('the defaults keep every dictation decode on Whisper, keyed like 6.72.0 records', () => {
    for (const slot of ['preview', 'fast', 'final'] as const) expect(dictationPlan(slot, settings(), caps()).engine).toBe('whisper')
    expect(dictationPlan('fast', settings(), caps()).key).toBe(legacyDictationKey('fast'))
    expect(dictationPlan('final', settings(), caps()).key).toBe(legacyDictationKey('hq'))
  })

  it('Parakeet runs only installed, warm and with the breaker closed; otherwise Whisper with the reason', () => {
    const s = settings({ preview: 'parakeet', hq: 'parakeet-ultra' })
    const cases: Array<[Partial<SttCapabilities>, string]> = [
      [{ parakeetInstalled: false }, 'parakeet_not_installed'],
      [{ parakeetPreviewBreakerOpen: true }, 'parakeet_breaker_open'],
      [{ parakeetPreviewWarm: false, parakeetPreviewWarming: true }, 'parakeet_warming'],
      [{ parakeetPreviewWarm: false }, 'parakeet_warming'],
      [{ parakeetPreviewWarm: false, parakeetPreviewWarmFailed: true }, 'parakeet_warm_failed'],
    ]
    for (const [over, reason] of cases) {
      for (const slot of ['preview', 'fast', 'final'] as const) {
        expect(dictationPlan(slot, s, caps(over)), `${slot} ${reason}`).toMatchObject({ engine: 'whisper', reason })
      }
    }
  })

  it('COS_DICTATION_FOLLOWS_STT=0 holds every dictation decode on Whisper under the 6.72.0 keys', () => {
    const s = settings({ preview: 'parakeet', hq: 'parakeet-ultra' })
    for (const slot of ['preview', 'fast', 'final'] as const) {
      expect(dictationPlan(slot, s, caps({ dictationDisabledByEnv: true }))).toMatchObject({ engine: 'whisper', reason: 'dictation_disabled_by_env' })
    }
    expect(dictationPlan('final', s, caps({ dictationDisabledByEnv: true })).key).toBe(legacyDictationKey('hq'))
  })

  it('Whisper choices in one slot share a key, so switching among them re-decodes nothing', () => {
    expect(dictationPlan('final', settings({ hq: 'large-v3-legacy' }), caps()).key).toBe('final:large-v3')
    expect(dictationPlan('fast', settings({ preview: 'nemotron-560' }), caps()).key).toBe('fast:turbo')
    expect(dictationPlan('fast', settings({ preview: 'parakeet' }), caps({ parakeetPreviewWarm: false })).key).toBe('fast:parakeet')
  })

  it('previews that are not offered keep dictation on Whisper and say why', () => {
    expect(dictationPlan('fast', settings({ preview: 'large-v3' }), caps())).toMatchObject({ engine: 'whisper', reason: 'large_v3_preview_not_offered' })
    expect(dictationPlan('preview', settings({ preview: 'nemotron-560' }), caps())).toMatchObject({ engine: 'whisper', reason: 'nemotron_not_wired' })
    expect(dictationPlan('final', settings({ preview: 'large-v3' }), caps()).reason).toBeNull()
  })

  it('GET adds a dictation block and appliesTo.dictation without removing anything', () => {
    const parakeet = { installed: true, installable: false, version: 'v', bytes: 1, progress: { state: 'installed', bytesDone: 1, bytesTotal: 1, error: null }, warm: { preview: 'warm' }, note: '' }
    const view = settingsView(settings({ preview: 'parakeet' }), caps(), parakeet)
    expect(view.appliesTo).toEqual({ preview: 'next live chunk', hq: 'next saved meeting', dictation: 'next dictation chunk' })
    for (const key of ['preview', 'hq', 'secondOpinion', 'resolver', 'frontEnd', 'quietGate', 'parakeet', 'lastJob']) expect(view).toHaveProperty(key)
    expect(view.dictation).toMatchObject({
      preview: { engine: 'parakeet-ultra', follows: 'preview', reasonCode: null },
      fast: { engine: 'parakeet-ultra', follows: 'preview' },
      final: { engine: 'whisper', follows: 'hq' },
      quietGate: 'none', secondOpinion: 'off', frontEnd: 'highpass',
    })
    expect(view.dictation.note).not.toMatch(/unchanged/i)
    const cold = dictationView(settings({ hq: 'parakeet-ultra' }), caps({ parakeetPreviewWarm: false, parakeetPreviewWarming: true }))
    expect(cold.final).toMatchObject({ engine: 'whisper', reasonCode: 'parakeet_warming', reason: 'Parakeet is warming up.' })
    expect(dictationView(settings(), caps()).frontEnd).toBe('raw')
  })
})

describe('runParakeetDictation', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-dict-stt-')); process.env.COS_DATA_DIR = dir; vi.resetModules() })
  afterEach(() => { delete process.env.COS_DATA_DIR; rmSync(dir, { recursive: true, force: true }) })
  const plan: DictationPlan = { slot: 'final', engine: 'parakeet-ultra', reason: null, frontEnd: 'highpass', key: 'final:parakeet-ultra' }
  const deps = (over: Record<string, unknown> = {}) => ({
    parakeet: vi.fn(async () => ({ text: 'parakeet words' })),
    frontEnd: vi.fn(async (a: Buffer) => a),
    hit: vi.fn(), miss: vi.fn(), ...over,
  })

  it('decodes a PCM WAV and closes the breaker on success', async () => {
    const { runParakeetDictation } = await import('./dictation-stt.js')
    const d = deps()
    expect(await runParakeetDictation(wav(), plan, 'interactive', d as any)).toEqual({ ok: true, text: 'parakeet words' })
    expect(d.hit).toHaveBeenCalledTimes(1)
    expect(d.parakeet).toHaveBeenCalledWith(expect.any(Buffer), 'interactive', expect.any(Number))
  })

  it('WebM (the browser recorder) never reaches Parakeet', async () => {
    const { runParakeetDictation, isPcm16kMonoWav } = await import('./dictation-stt.js')
    const d = deps()
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200)])
    expect(isPcm16kMonoWav(webm)).toBe(false)
    expect(isPcm16kMonoWav(wav())).toBe(true)
    expect(await runParakeetDictation(webm, plan, 'interactive', d as any)).toEqual({ ok: false, reason: 'audio_not_pcm_wav' })
    expect(d.parakeet).not.toHaveBeenCalled()
  })

  it('a busy lane is not a breaker miss; a failure is', async () => {
    const { runParakeetDictation } = await import('./dictation-stt.js')
    const { ParakeetError } = await import('./parakeet.js')
    const busy = deps({ parakeet: vi.fn(async () => { throw new ParakeetError('busy', 'busy') }) })
    expect(await runParakeetDictation(wav(), plan, 'preview', busy as any)).toEqual({ ok: false, reason: 'parakeet_busy' })
    expect(busy.miss).not.toHaveBeenCalled()
    const failed = deps({ parakeet: vi.fn(async () => { throw new ParakeetError('timeout', 'slow') }) })
    expect(await runParakeetDictation(wav(), plan, 'interactive', failed as any)).toEqual({ ok: false, reason: 'parakeet_failed' })
    expect(failed.miss).toHaveBeenCalledTimes(1)
  })

  it('a front-end failure decodes the raw audio instead of failing', async () => {
    const { runParakeetDictation } = await import('./dictation-stt.js')
    const d = deps({ frontEnd: vi.fn(async () => { throw new Error('ffmpeg missing') }) })
    expect(await runParakeetDictation(wav(), plan, 'interactive', d as any)).toEqual({ ok: true, text: 'parakeet words' })
    expect(d.miss).not.toHaveBeenCalled()
  })

  it('a whisper plan never runs Parakeet', async () => {
    const { runParakeetDictation } = await import('./dictation-stt.js')
    const d = deps()
    await runParakeetDictation(wav(), { ...plan, engine: 'whisper' }, 'interactive', d as any)
    expect(d.parakeet).not.toHaveBeenCalled()
  })
})

describe('transcribeAudioBuffer follows the plan (6.73.0)', () => {
  let transcribeAudioBuffer: typeof import('./transcribe-audio.js').transcribeAudioBuffer
  let transcribeLocal: ReturnType<typeof vi.fn>
  let transcribeHighQuality: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    delete process.env.COS_OPENAI_WHISPER_FALLBACK
    transcribeLocal = vi.fn(async () => ({ text: 'whisper fast text', backend: 'server' }))
    transcribeHighQuality = vi.fn(async () => ({ text: 'whisper hq text', model: 'large-v3', backend: 'whisper-cli', actualQuality: 'hq' }))
    vi.doMock('./whisper-local.js', () => ({
      isWhisperLocalAvailable: () => true, transcribeLocal, transcribeHighQuality,
      getWhisperBackend: () => 'mock', applyCorrections: (t: string) => t,
    }))
    vi.doMock('./speaker-embeddings.js', () => ({ AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72, AUTO_ENROLL_THRESHOLD: 0.88, getAllSpeakerNames: () => [] }))
    ;({ transcribeAudioBuffer } = await import('./transcribe-audio.js'))
  })
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('./whisper-local.js')
    vi.doUnmock('./speaker-embeddings.js')
  })

  const planOf = (slot: 'fast' | 'final' | 'preview', engine: 'whisper' | 'parakeet-ultra', reason: string | null = null): DictationPlan =>
    ({ slot, engine, reason, frontEnd: 'highpass', key: `${slot}:${engine === 'whisper' ? 'turbo' : 'parakeet'}` })
  const deskOf = (slot: 'fast' | 'final' | 'preview', engine: 'whisper' | 'parakeet-ultra', reason: string | null = null, setting: 'auto' | 'parakeet-ultra' | 'whisper' = 'auto') =>
    ({ ...planOf(slot, engine, reason), setting, whisperAllowed: setting !== 'parakeet-ultra' })

  it('Fast mode asks for the Fast (Preview model) plan and HQ for the final (HQ model) plan', async () => {
    const plan = vi.fn((slot: any) => planOf(slot, 'whisper'))
    const parakeet = vi.fn()
    await transcribeAudioBuffer(wav(2), { mode: 'fast', sttDeps: { plan, parakeet } })
    expect(plan).toHaveBeenLastCalledWith('fast')
    expect(transcribeLocal).toHaveBeenCalledTimes(1)
    await transcribeAudioBuffer(wav(2), { mode: 'hq', sttDeps: { plan, parakeet } })
    expect(plan).toHaveBeenLastCalledWith('final')
    expect(transcribeHighQuality).toHaveBeenCalledTimes(1)
    expect(parakeet).not.toHaveBeenCalled()
  })

  it('a Parakeet HQ decode is reported as HQ, not degraded, with the engine named', async () => {
    const parakeet = vi.fn(async () => ({ ok: true as const, text: 'parakeet hq text' }))
    const result = await transcribeAudioBuffer(wav(2), { mode: 'hq', sttDeps: { plan: s => planOf(s, 'parakeet-ultra'), parakeet } })
    expect(result).toMatchObject({ text: 'parakeet hq text', backend: 'parakeet-ultra', actualQuality: 'hq', degraded: false, engine: 'parakeet-ultra', requestedMode: 'hq' })
    expect(result.engineReason).toBeUndefined()
    expect(transcribeHighQuality).not.toHaveBeenCalled()
    expect(transcribeLocal).not.toHaveBeenCalled()
  })

  it('Fast mode on Parakeet reports Fast and never touches Whisper', async () => {
    const parakeet = vi.fn(async () => ({ ok: true as const, text: 'parakeet fast text' }))
    const result = await transcribeAudioBuffer(wav(2), { mode: 'fast', sttDeps: { plan: s => planOf(s, 'parakeet-ultra'), parakeet } })
    expect(result).toMatchObject({ backend: 'parakeet-ultra', actualQuality: 'fast', engine: 'parakeet-ultra' })
    expect(transcribeLocal).not.toHaveBeenCalled()
  })

  it('a failed Parakeet decode is the 6.72.0 Whisper decode of the same audio, with a plain reason', async () => {
    const audio = wav(2)
    const parakeet = vi.fn(async () => ({ ok: false as const, reason: 'parakeet_failed' as const }))
    const result = await transcribeAudioBuffer(audio, { mode: 'hq', sttDeps: { plan: s => planOf(s, 'parakeet-ultra'), parakeet } })
    expect(result).toMatchObject({ text: 'whisper hq text', backend: 'hq-large-v3', engine: 'whisper', engineReason: 'parakeet_failed', degraded: false })
    expect(transcribeHighQuality).toHaveBeenCalledWith(audio, undefined, expect.anything())
  })

  it('pinned Mac dictation refuses a cold engine and never runs Whisper', async () => {
    const parakeet = vi.fn()
    await expect(transcribeAudioBuffer(wav(2), { mode: 'fast', requiredEngine: 'parakeet-ultra',
      sttDeps: { plan: s => planOf(s, 'whisper'), desktopPlan: s => deskOf(s, 'whisper', 'parakeet_warming'), parakeet } }))
      .rejects.toMatchObject({ status: 503, reason: 'parakeet_unavailable' })
    expect(parakeet).not.toHaveBeenCalled()
    expect(transcribeLocal).not.toHaveBeenCalled()
    expect(transcribeHighQuality).not.toHaveBeenCalled()
  })

  it.each(['parakeet_busy', 'parakeet_failed', 'audio_not_pcm_wav'] as const)('pinned Mac dictation refuses %s without engine substitution', async reason => {
    const parakeet = vi.fn(async () => ({ ok: false as const, reason }))
    await expect(transcribeAudioBuffer(wav(2), { mode: 'fast', requiredEngine: 'parakeet-ultra',
      sttDeps: { plan: s => planOf(s, 'whisper'), desktopPlan: s => deskOf(s, 'parakeet-ultra'), parakeet } }))
      .rejects.toMatchObject({ status: 503, reason: 'parakeet_unavailable' })
    expect(transcribeLocal).not.toHaveBeenCalled()
    expect(transcribeHighQuality).not.toHaveBeenCalled()
  })

  it('pinned Mac dictation uses the shared Parakeet result and correction pipeline', async () => {
    const parakeet = vi.fn(async () => ({ ok: true as const, text: 'Review the launch tomorrow.' }))
    const result = await transcribeAudioBuffer(wav(2), { mode: 'fast', requiredEngine: 'parakeet-ultra',
      sttDeps: { plan: s => planOf(s, 'whisper'), desktopPlan: s => deskOf(s, 'parakeet-ultra'), parakeet } })
    expect(result).toMatchObject({ text: 'Review the launch tomorrow.', engine: 'parakeet-ultra', backend: 'parakeet-ultra' })
    expect(transcribeLocal).not.toHaveBeenCalled()
  })

  it('a cold Parakeet (plan already on Whisper) decodes on Whisper and keeps the reason', async () => {
    const parakeet = vi.fn()
    const result = await transcribeAudioBuffer(wav(2), { mode: 'fast', sttDeps: { plan: s => planOf(s, 'whisper', 'parakeet_warming'), parakeet } })
    expect(parakeet).not.toHaveBeenCalled()
    expect(result).toMatchObject({ text: 'whisper fast text', engine: 'whisper', engineReason: 'parakeet_warming' })
  })

  it('a caller snapshot is used as is, and an HQ clip over 60 s is planned for the Fast slot', async () => {
    const plan = vi.fn((slot: any) => planOf(slot, 'whisper'))
    await transcribeAudioBuffer(wav(2), { mode: 'hq', dictationPlan: planOf('final', 'whisper'), sttDeps: { plan, parakeet: vi.fn() } })
    expect(plan).not.toHaveBeenCalled()
    await transcribeAudioBuffer(wav(61), { mode: 'hq', dictationPlan: planOf('final', 'parakeet-ultra'), sttDeps: { plan, parakeet: vi.fn() } })
    expect(plan).toHaveBeenLastCalledWith('fast')
  })

  it('the default production plan never throws when the settings or capabilities cannot be read', async () => {
    const result = await transcribeAudioBuffer(wav(2), { mode: 'fast' })
    expect(result).toMatchObject({ engine: 'whisper', text: 'whisper fast text' })
  })
})
