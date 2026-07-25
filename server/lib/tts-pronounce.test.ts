import { afterEach, describe, expect, it } from 'vitest'
import { applyLocalPronunciation, applyOpenAIPronunciation } from './tts-pronounce.js'

describe('public TTS pronunciation lexicon', () => {
  afterEach(() => {
    delete process.env.COS_TTS_PRONUNCIATIONS_JSON
  })

  it('is a no-op unless the operator explicitly configures a lexicon', () => {
    expect(applyLocalPronunciation('Exampleco')).toBe('Exampleco')
    expect(applyOpenAIPronunciation('Exampleco')).toBe('Exampleco')
  })

  it('applies local and OpenAI variants case-insensitively', () => {
    process.env.COS_TTS_PRONUNCIATIONS_JSON = JSON.stringify({
      Exampleco: {
        local: '[Exampleco](/ɪgzˈæmpəlkoʊ/)',
        openai: 'ig-ZAM-pul-co',
      },
    })
    expect(applyLocalPronunciation('exampleco update')).toBe('[Exampleco](/ɪgzˈæmpəlkoʊ/) update')
    expect(applyOpenAIPronunciation('EXAMPLECO update')).toBe('ig-ZAM-pul-co update')
  })

  it('fails closed to unchanged text for invalid JSON', () => {
    process.env.COS_TTS_PRONUNCIATIONS_JSON = '{bad'
    expect(applyLocalPronunciation('Exampleco')).toBe('Exampleco')
  })
})
