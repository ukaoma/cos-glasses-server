// 6.74.0: Mac dictation for every user (docs/dictation-stt-contract.md, "Mac dictation").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applySettingsPatch, DEFAULT_STT_SETTINGS, desktopDictationPlan, desktopDictationView, dictationPlan, normalizeStoredSettings,
  SttSettingsError, type DesktopDictationPlan, type DictationPlan, type SttCapabilities, type SttSettings,
} from './stt-settings.js'
import { desktopFailureHint, type DesktopFailureFacts } from './dictation-stt.js'

const caps = (over: Partial<SttCapabilities> = {}): SttCapabilities => ({
  turboModel: true, liveLargeV3: false, hqLargeV3: true, parakeetInstalled: true,
  parakeetPreviewWarm: true, parakeetPreviewWarming: false, parakeetPreviewWarmFailed: false,
  parakeetPreviewBreakerOpen: false, previewDisabledByEnv: false, ...over,
})
const settings = (over: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...over })

function wav(seconds = 1): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * 16_000) * 2)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(800 * Math.sin(i / 8)), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24)
  h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

describe('the dictation setting (pure)', () => {
  it('defaults to auto, and every pre-6.74 file (no key) reads as auto, including Macs that chose Parakeet', () => {
    expect(DEFAULT_STT_SETTINGS.dictation).toBe('auto')
    expect(normalizeStoredSettings({}).dictation).toBe('auto')
    expect(normalizeStoredSettings({ preview: 'parakeet', hq: 'parakeet-ultra' })).toMatchObject({ preview: 'parakeet', hq: 'parakeet-ultra', dictation: 'auto' })
    expect(normalizeStoredSettings({ dictation: 'cloud' }).dictation).toBe('auto')
    expect(normalizeStoredSettings({ dictation: 'whisper' }).dictation).toBe('whisper')
    expect(normalizeStoredSettings({ dictation: 'parakeet-ultra' }).dictation).toBe('parakeet-ultra')
  })

  it('PUT accepts each id, refuses an unknown one and a choice this Mac cannot run', () => {
    expect(applySettingsPatch(settings(), { dictation: 'whisper' }, caps()).dictation).toBe('whisper')
    expect(applySettingsPatch(settings(), { dictation: 'parakeet-ultra' }, caps()).dictation).toBe('parakeet-ultra')
    expect(() => applySettingsPatch(settings(), { dictation: 'cloud' }, caps())).toThrow(SttSettingsError)
    expect(() => applySettingsPatch(settings(), { dictation: 'parakeet-ultra' }, caps({ parakeetInstalled: false }))).toThrow(/Install Parakeet/)
    expect(() => applySettingsPatch(settings(), { dictation: 'whisper' }, caps({ turboModel: false, liveLargeV3: false }))).toThrow(/Whisper weights are missing/)
    // auto is always available: it is what a Mac with nothing installed yet starts on.
    expect(applySettingsPatch(settings({ dictation: 'whisper' }), { dictation: 'auto' }, caps({ parakeetInstalled: false, turboModel: false })).dictation).toBe('auto')
  })

  it('Mac dictation does not follow the Preview model', () => {
    // Preview Turbo, auto, Parakeet warm: Parakeet. The 6.73 plan for the same settings is Whisper.
    expect(desktopDictationPlan('fast', settings({ preview: 'turbo' }), caps())).toMatchObject({ engine: 'parakeet-ultra', reason: null, setting: 'auto', whisperAllowed: true })
    expect(dictationPlan('fast', settings({ preview: 'turbo' }), caps()).engine).toBe('whisper')
    // Preview Parakeet, dictation whisper: Whisper.
    expect(desktopDictationPlan('fast', settings({ preview: 'parakeet', dictation: 'whisper' }), caps())).toMatchObject({ engine: 'whisper', reason: null, whisperAllowed: true })
  })

  it('auto uses Parakeet only installed, warm and breaker closed; otherwise Whisper with the reason', () => {
    const cases: Array<[Partial<SttCapabilities>, string]> = [
      [{ parakeetInstalled: false }, 'parakeet_not_installed'],
      [{ parakeetPreviewBreakerOpen: true }, 'parakeet_breaker_open'],
      [{ parakeetPreviewWarm: false, parakeetPreviewWarming: true }, 'parakeet_warming'],
      [{ parakeetPreviewWarm: false }, 'parakeet_warming'],
      [{ parakeetPreviewWarm: false, parakeetPreviewWarmFailed: true }, 'parakeet_warm_failed'],
      [{ dictationDisabledByEnv: true }, 'dictation_disabled_by_env'],
    ]
    for (const [over, reason] of cases) {
      expect(desktopDictationPlan('fast', settings(), caps(over)), reason).toMatchObject({ engine: 'whisper', reason, whisperAllowed: true, key: 'fast:turbo' })
      expect(desktopDictationPlan('fast', settings({ dictation: 'parakeet-ultra' }), caps(over)), reason).toMatchObject({ engine: 'whisper', reason, whisperAllowed: false })
    }
    expect(desktopDictationPlan('final', settings(), caps())).toMatchObject({ engine: 'parakeet-ultra', key: 'final:parakeet-ultra' })
    expect(desktopDictationPlan('fast', settings({ dictation: 'whisper' }), caps({ parakeetInstalled: false })).reason).toBeNull()
  })

  it('GET dictation.desktop says what runs now, in a sentence a person can act on', () => {
    expect(desktopDictationView(settings(), caps())).toMatchObject({ selected: 'auto', effective: 'parakeet-ultra', reasonCode: null })
    const cold = desktopDictationView(settings(), caps({ parakeetInstalled: false }))
    expect(cold).toMatchObject({ effective: 'whisper', reasonCode: 'parakeet_not_installed' })
    expect(cold.note).toMatch(/Whisper on this Mac for now/)
    expect(desktopDictationView(settings({ dictation: 'parakeet-ultra' }), caps({ parakeetPreviewWarm: false }))).toMatchObject({ effective: 'none', reasonCode: 'parakeet_warming' })
    expect(desktopDictationView(settings(), caps({ parakeetInstalled: false, turboModel: false, liveLargeV3: false })).effective).toBe('none')
    expect(desktopDictationView(settings(), caps()).options.map(o => o.id)).toEqual(['auto', 'parakeet-ultra', 'whisper'])
    for (const v of [cold, desktopDictationView(settings({ dictation: 'parakeet-ultra' }), caps({ parakeetPreviewWarm: false }))]) {
      expect(v.note).not.toMatch(/—|→/)
    }
  })
})

describe('the one action a failure offers (pure)', () => {
  const f = (over: Partial<DesktopFailureFacts>): DesktopFailureFacts => ({
    kind: 'no_local_engine', parakeetReason: null, parakeetInstallable: false, whisperStarting: false, whisperPresent: true, ...over,
  })
  it('no_local_engine', () => {
    expect(desktopFailureHint(f({ whisperStarting: true }))).toEqual({ action: 'retry_when_warm', retryable: true, detail: 'whisper_starting' })
    expect(desktopFailureHint(f({ parakeetReason: 'parakeet_warming' }))).toEqual({ action: 'retry_when_warm', retryable: true, detail: 'whisper_unavailable' })
    expect(desktopFailureHint(f({ parakeetReason: 'parakeet_not_installed', parakeetInstallable: true, whisperPresent: false }))).toEqual({ action: 'install_parakeet', retryable: false, detail: 'whisper_missing' })
    expect(desktopFailureHint(f({ parakeetReason: 'parakeet_not_installed', parakeetInstallable: false }))).toEqual({ action: 'open_transcription_settings', retryable: false, detail: 'whisper_unavailable' })
    expect(desktopFailureHint(f({ parakeetReason: 'parakeet_failed' }))).toMatchObject({ action: 'open_transcription_settings', retryable: false })
  })
  it('parakeet_unavailable (the explicit parakeet-ultra setting)', () => {
    const p = (reason: string | null, installable = true) => desktopFailureHint(f({ kind: 'parakeet_unavailable', parakeetReason: reason, parakeetInstallable: installable }))
    expect(p('parakeet_not_installed')).toEqual({ action: 'install_parakeet', retryable: false, detail: 'parakeet_not_installed' })
    expect(p('parakeet_not_installed', false)).toEqual({ action: 'use_whisper', retryable: false, detail: 'parakeet_not_installed' })
    expect(p('parakeet_warming')).toEqual({ action: 'retry_when_warm', retryable: true, detail: 'parakeet_warming' })
    expect(p('parakeet_busy')).toEqual({ action: 'retry_when_warm', retryable: true, detail: 'parakeet_busy' })
    for (const r of ['parakeet_warm_failed', 'parakeet_breaker_open', 'parakeet_failed', 'audio_not_pcm_wav', 'dictation_disabled_by_env']) {
      expect(p(r), r).toEqual({ action: 'use_whisper', retryable: false, detail: r })
    }
    expect(p(null)).toMatchObject({ action: 'use_whisper', detail: 'parakeet_failed' })
  })
})

describe('transcribeAudioBuffer: Mac dictation engine policy and compatibility', () => {
  let transcribeAudioBuffer: typeof import('./transcribe-audio.js').transcribeAudioBuffer
  let transcribeLocal: ReturnType<typeof vi.fn>
  let transcribeHighQuality: ReturnType<typeof vi.fn>
  let cloudFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    // A configured cloud fallback must still never be used for Mac dictation.
    process.env.COS_OPENAI_WHISPER_FALLBACK = '1'
    process.env.OPENAI_API_KEY = 'sk-test-never-used'
    cloudFetch = vi.fn(async () => { throw new Error('cloud must not be called') })
    vi.stubGlobal('fetch', cloudFetch)
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
    vi.unstubAllGlobals()
    delete process.env.COS_OPENAI_WHISPER_FALLBACK
    delete process.env.OPENAI_API_KEY
    vi.resetModules()
    vi.doUnmock('./whisper-local.js')
    vi.doUnmock('./speaker-embeddings.js')
  })

  const desk = (engine: 'whisper' | 'parakeet-ultra', reason: string | null = null, setting: 'auto' | 'parakeet-ultra' | 'whisper' = 'auto') =>
    (slot: any): DesktopDictationPlan => ({ slot, engine, reason, frontEnd: 'highpass', key: `${slot}:x`, setting, whisperAllowed: setting !== 'parakeet-ultra' })
  const previewPlan = (engine: 'whisper' | 'parakeet-ultra') => (slot: any): DictationPlan => ({ slot, engine, reason: null, frontEnd: 'highpass', key: `${slot}:p` })
  const ok = () => vi.fn(async () => ({ ok: true as const, text: 'parakeet words' }))
  const failing = (reason: 'parakeet_busy' | 'parakeet_failed' | 'audio_not_pcm_wav') => vi.fn(async () => ({ ok: false as const, reason }))
  const hint = vi.fn((kind: string, reason: string | null) => ({ action: 'open_transcription_settings' as const, retryable: false, detail: `${kind}:${reason}` }))
  const local = { mode: 'fast' as const, requiredEngine: 'local' as const, policy: 'local-only' as const, affectsCircuit: false }
  const whisperDown = () => transcribeLocal.mockRejectedValue(new Error('whisper-server unavailable'))

  it('auto, Parakeet warm: Parakeet, no fallback, setting echoed', async () => {
    const parakeet = ok()
    const r = await transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('parakeet-ultra'), parakeet, failureHint: hint } })
    expect(r).toMatchObject({ text: 'parakeet words', engine: 'parakeet-ultra', dictationSetting: 'auto' })
    expect(r.fallbackReason).toBeUndefined()
    expect(transcribeLocal).not.toHaveBeenCalled()
  })

  it.each(['parakeet_not_installed', 'parakeet_warming', 'parakeet_warm_failed', 'parakeet_breaker_open', 'dictation_disabled_by_env'])('auto, %s: local Whisper, fallbackReason set, Parakeet never tried', async reason => {
    const parakeet = ok()
    const r = await transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('parakeet-ultra'), desktopPlan: desk('whisper', reason), parakeet, failureHint: hint } })
    expect(r).toMatchObject({ text: 'whisper fast text', engine: 'whisper', fallbackReason: reason, engineReason: reason, dictationSetting: 'auto' })
    expect(parakeet).not.toHaveBeenCalled()
    expect(transcribeLocal).toHaveBeenCalledTimes(1)
    expect(cloudFetch).not.toHaveBeenCalled()
  })

  it.each(['parakeet_busy', 'parakeet_failed', 'audio_not_pcm_wav'] as const)('auto, decode %s: Whisper decodes the same audio', async reason => {
    const audio = wav(2)
    const r = await transcribeAudioBuffer(audio, { ...local, sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('parakeet-ultra'), parakeet: failing(reason), failureHint: hint } })
    expect(r).toMatchObject({ engine: 'whisper', fallbackReason: reason })
    expect(transcribeLocal).toHaveBeenCalledWith(audio, undefined, undefined, { affectsCircuit: false })
  })

  it('requiredEngine=local is local only by itself, even when the caller passes no policy', async () => {
    whisperDown()
    const err = await transcribeAudioBuffer(wav(2), { mode: 'fast', requiredEngine: 'local', sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('whisper', 'parakeet_not_installed'), parakeet: ok(), failureHint: hint } }).catch(e => e)
    expect(err).toMatchObject({ status: 503, reason: 'no_local_engine' })
    expect(cloudFetch).not.toHaveBeenCalled()
    // Control: the same Whisper failure without requiredEngine reaches the configured cloud fallback.
    const phone = await transcribeAudioBuffer(wav(2), { mode: 'fast', sttDeps: { plan: previewPlan('whisper'), parakeet: ok() } }).catch(e => e)
    expect(cloudFetch).toHaveBeenCalled()
    expect(phone).toBeInstanceOf(Error)
  })

  it('auto, nothing local can run: 503 no_local_engine with the action, never the cloud', async () => {
    whisperDown()
    const err = await transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('whisper', 'parakeet_not_installed'), parakeet: ok(), failureHint: hint } }).catch(e => e)
    expect(err).toMatchObject({ status: 503, reason: 'no_local_engine', hint: { action: 'open_transcription_settings', retryable: false, detail: 'no_local_engine:parakeet_not_installed' } })
    expect(err.message).toMatch(/Open Transcription settings/)
    expect(cloudFetch).not.toHaveBeenCalled()
  })

  it('auto in HQ mode: the Whisper HQ path, then fast, still local only', async () => {
    transcribeHighQuality.mockRejectedValueOnce(new Error('cli down'))
    whisperDown()
    const err = await transcribeAudioBuffer(wav(2), { ...local, mode: 'hq', sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('whisper', 'parakeet_warming'), parakeet: ok(), failureHint: hint } }).catch(e => e)
    expect(err).toMatchObject({ reason: 'no_local_engine' })
    expect(transcribeHighQuality).toHaveBeenCalledTimes(1)
    expect(cloudFetch).not.toHaveBeenCalled()
  })

  it('whisper setting: Parakeet never runs, no fallbackReason, failure is no_local_engine', async () => {
    const parakeet = ok()
    const r = await transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('parakeet-ultra'), desktopPlan: desk('whisper', null, 'whisper'), parakeet, failureHint: hint } })
    expect(r).toMatchObject({ engine: 'whisper', dictationSetting: 'whisper' })
    expect(r.fallbackReason).toBeUndefined()
    expect(parakeet).not.toHaveBeenCalled()
    whisperDown()
    await expect(transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('whisper', null, 'whisper'), parakeet, failureHint: hint } }))
      .rejects.toMatchObject({ reason: 'no_local_engine' })
  })

  it('parakeet-ultra setting with requiredEngine=local is strict: no Whisper, a hint with the action', async () => {
    const cold = await transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('whisper', 'parakeet_warming', 'parakeet-ultra'), parakeet: ok(), failureHint: hint } }).catch(e => e)
    expect(cold).toMatchObject({ status: 503, reason: 'parakeet_unavailable', hint: { detail: 'parakeet_unavailable:parakeet_warming' } })
    const failed = await transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('parakeet-ultra', null, 'parakeet-ultra'), parakeet: failing('parakeet_busy'), failureHint: hint } }).catch(e => e)
    expect(failed).toMatchObject({ reason: 'parakeet_unavailable', hint: { detail: 'parakeet_unavailable:parakeet_busy' } })
    expect(transcribeLocal).not.toHaveBeenCalled()
    const r = await transcribeAudioBuffer(wav(2), { ...local, sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('parakeet-ultra', null, 'parakeet-ultra'), parakeet: ok(), failureHint: hint } })
    expect(r).toMatchObject({ engine: 'parakeet-ultra', dictationSetting: 'parakeet-ultra' })
  })

  // Compatibility matrix: old request (parakeet-ultra, COS Control 0.5.316) x settings.
  it.each([
    ['auto', 'parakeet-ultra'],
    ['parakeet-ultra', 'parakeet-ultra'],
  ] as const)('old request, setting %s, Parakeet warm: Parakeet', async (setting, engine) => {
    const r = await transcribeAudioBuffer(wav(2), { mode: 'fast', requiredEngine: 'parakeet-ultra', policy: 'local-only', affectsCircuit: false,
      sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk(engine, null, setting), parakeet: ok(), failureHint: hint } })
    expect(r).toMatchObject({ engine: 'parakeet-ultra', backend: 'parakeet-ultra' })
  })

  it.each([
    ['auto', 'parakeet_not_installed'], ['auto', 'parakeet_warming'], ['whisper', null], ['parakeet-ultra', 'parakeet_breaker_open'],
  ] as const)('old request, setting %s (%s): the exact 6.73 refusal, no hint, no Whisper', async (setting, reason) => {
    const err = await transcribeAudioBuffer(wav(2), { mode: 'fast', requiredEngine: 'parakeet-ultra', policy: 'local-only', affectsCircuit: false,
      sttDeps: { plan: previewPlan('parakeet-ultra'), desktopPlan: desk('whisper', reason, setting), parakeet: ok(), failureHint: hint } }).catch(e => e)
    expect(err).toMatchObject({ status: 503, reason: 'parakeet_unavailable', message: 'Parakeet is not ready. Select Parakeet for dictation in Transcription settings and retry.' })
    expect(err.hint).toBeUndefined()
    expect(transcribeLocal).not.toHaveBeenCalled()
  })

  it('old request, decode failed under auto: the exact 6.73 decode refusal, never Whisper', async () => {
    const err = await transcribeAudioBuffer(wav(2), { mode: 'fast', requiredEngine: 'parakeet-ultra', policy: 'local-only', affectsCircuit: false,
      sttDeps: { plan: previewPlan('whisper'), desktopPlan: desk('parakeet-ultra'), parakeet: failing('parakeet_failed'), failureHint: hint } }).catch(e => e)
    expect(err).toMatchObject({ reason: 'parakeet_unavailable', message: 'Parakeet could not transcribe this audio. Retry when it is ready; no other engine was used.' })
    expect(err.hint).toBeUndefined()
    expect(transcribeLocal).not.toHaveBeenCalled()
  })

  it('a request with no requiredEngine (phone, glasses) still follows the Preview plan, not the Mac setting', async () => {
    const desktopPlan = vi.fn(desk('parakeet-ultra'))
    const parakeet = ok()
    const r = await transcribeAudioBuffer(wav(2), { mode: 'fast', sttDeps: { plan: previewPlan('whisper'), desktopPlan, parakeet, failureHint: hint } })
    expect(desktopPlan).not.toHaveBeenCalled()
    expect(parakeet).not.toHaveBeenCalled()
    expect(r.engine).toBe('whisper')
    expect(r.dictationSetting).toBeUndefined()
    expect(r.fallbackReason).toBeUndefined()
  })
})
