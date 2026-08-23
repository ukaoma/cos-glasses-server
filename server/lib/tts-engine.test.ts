import { describe, it, expect, afterEach } from 'vitest'
import {
  decideInitialBackend,
  getTtsEngineMode,
  mapOpenAIVoiceToLocal,
  resolveLocalVoice,
  canFallbackToLocal,
  canFallbackToOpenAI,
  isKokoroVoiceId,
} from './tts-engine.js'
import { hashKey } from './tts-cache.js'

describe('tts-engine Phase 1 modes', () => {
  afterEach(() => {
    delete process.env.COS_TTS_ENGINE
    delete process.env.COS_TTS_KOKORO_VOICE
  })

  it('defaults to local_first and maps echo → am_echo', () => {
    delete process.env.COS_TTS_ENGINE
    expect(getTtsEngineMode()).toBe('local_first')
    expect(mapOpenAIVoiceToLocal('echo')).toBe('am_echo')
  })

  it('accepts explicit Kokoro voice ids', () => {
    expect(isKokoroVoiceId('am_michael')).toBe(true)
    expect(resolveLocalVoice('am_michael')).toBe('am_michael')
  })

  // The picker offers these, so the server has to accept them. A catalog the
  // server then rejects is the UI-and-server-disagree bug in miniature.
  it('accepts the British ids the picker offers', () => {
    for (const id of ['bm_george', 'bm_daniel', 'bm_lewis', 'bm_fable',
                      'bf_emma', 'bf_alice', 'bf_isabella', 'bf_lily']) {
      expect(isKokoroVoiceId(id), id).toBe(true)
      expect(resolveLocalVoice(id), id).toBe(id)
    }
  })

  // 26 of the 54 packaged voices are Mandarin, Japanese, Hindi, Spanish,
  // Portuguese, Italian and French. The sidecar phonemises with lang_code="a",
  // so those would be read through an American English G2P pass -- an accent
  // artefact, not the language. Deliberately not offered.
  it('does NOT accept the non-English voices that ship in the same pack', () => {
    for (const id of ['zf_xiaoxiao', 'jf_alpha', 'hf_alpha', 'ef_dora', 'if_sara', 'pf_dora', 'ff_siwis']) {
      expect(isKokoroVoiceId(id), id).toBe(false)
    }
  })

  it('enginePreference local forces Kokoro when ready', () => {
    process.env.COS_TTS_ENGINE = 'local_first'
    expect(
      decideInitialBackend({
        openaiVoice: 'am_fenrir',
        openaiKeyPresent: true,
        openaiBudgetOk: true,
        localReady: true,
        enginePreference: 'local',
      }),
    ).toMatchObject({ backend: 'local', backendVoice: 'am_fenrir', engineTag: 'kokoro' })
  })

  it('enginePreference local fails closed when Kokoro is unavailable', () => {
    process.env.COS_TTS_ENGINE = 'local_first'
    expect(() => decideInitialBackend({
      openaiVoice: 'am_echo',
      openaiKeyPresent: true,
      openaiBudgetOk: true,
      localReady: false,
      enginePreference: 'local',
    })).toThrow('Local TTS selected but Kokoro sidecar is not ready')
  })

  it('enginePreference openai forces OpenAI when key+budget OK', () => {
    process.env.COS_TTS_ENGINE = 'local_first'
    expect(
      decideInitialBackend({
        openaiVoice: 'echo',
        openaiKeyPresent: true,
        openaiBudgetOk: true,
        localReady: true,
        enginePreference: 'openai',
      }).backend,
    ).toBe('openai')
  })

  it('preferOpenAI forces OpenAI when key+budget OK under local_first', () => {
    process.env.COS_TTS_ENGINE = 'local_first'
    expect(
      decideInitialBackend({
        openaiVoice: 'echo',
        openaiKeyPresent: true,
        openaiBudgetOk: true,
        localReady: true,
        preferOpenAI: true,
      }).backend,
    ).toBe('openai')
  })

  it('forceLocal blocks OpenAI fallback helper', () => {
    expect(canFallbackToOpenAI('local_first', true, true, true)).toBe(false)
    expect(canFallbackToOpenAI('local_first', true, true, false)).toBe(true)
  })

  it('openai_primary prefers OpenAI when key+budget, else local', () => {
    process.env.COS_TTS_ENGINE = 'openai_primary'
    expect(
      decideInitialBackend({
        openaiVoice: 'echo',
        openaiKeyPresent: true,
        openaiBudgetOk: true,
        localReady: true,
      }).backend,
    ).toBe('openai')

    expect(
      decideInitialBackend({
        openaiVoice: 'echo',
        openaiKeyPresent: true,
        openaiBudgetOk: false,
        localReady: true,
      }),
    ).toMatchObject({ backend: 'local', backendVoice: 'am_echo', engineTag: 'kokoro' })
  })

  it('fails closed when openai_primary has neither path', () => {
    process.env.COS_TTS_ENGINE = 'openai_primary'
    expect(() =>
      decideInitialBackend({
        openaiVoice: 'echo',
        openaiKeyPresent: false,
        openaiBudgetOk: false,
        localReady: false,
      }),
    ).toThrow(/local TTS sidecar is not ready/)
  })

  it('canFallbackToLocal only for openai_primary/local_first', () => {
    expect(canFallbackToLocal('openai_primary', true)).toBe(true)
    expect(canFallbackToLocal('local_first', true)).toBe(true)
    expect(canFallbackToLocal('openai', true)).toBe(false)
    expect(canFallbackToLocal('local', true)).toBe(false)
  })

  it('hashKey separates openai vs kokoro for same text', () => {
    const text = 'Hello COS'
    const a = hashKey('openai', 'echo', 'mp3', text)
    const b = hashKey('kokoro', 'am_echo', 'mp3', text)
    expect(a).not.toBe(b)
  })
})

