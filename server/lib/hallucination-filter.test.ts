import { describe, expect, it } from 'vitest'
import { isCaptionCreditHallucination, isFullHallucination } from './hallucination-filter.js'

describe('caption-credit hallucination filter', () => {
  it('drops the observed Large-v3 caption-training artifact', () => {
    const artifact = 'CLOSED CAPTIONING PROVIDED BY AEVERINE ZINN DIGITAL MEDIA GROUP'
    expect(isCaptionCreditHallucination(artifact)).toBe(true)
    expect(isFullHallucination(artifact)).toBe(true)
  })

  it('preserves legitimate discussion of closed captioning', () => {
    const speech = 'What does closed captioning provided by the platform include?'
    expect(isCaptionCreditHallucination(speech)).toBe(false)
    expect(isFullHallucination(speech)).toBe(false)
  })
})
