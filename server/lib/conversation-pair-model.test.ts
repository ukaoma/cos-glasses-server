import { describe, expect, it } from 'vitest'
import { resolveExchangePairModel } from './conversation.js'

describe('resolveExchangePairModel', () => {
  it('prefers assistant then user then session stamps', () => {
    expect(resolveExchangePairModel(
      { modelPreference: 'sonnet' },
      { modelPreference: 'cursor-grok' },
      'opus',
    )).toBe('cursor-grok')
    expect(resolveExchangePairModel(
      { modelPreference: 'cursor-composer' },
      {},
      'opus',
    )).toBe('cursor-composer')
    expect(resolveExchangePairModel({}, {}, 'cursor-grok')).toBe('cursor-grok')
  })

  it('returns undefined when nothing is stamped (never invents Opus)', () => {
    expect(resolveExchangePairModel({}, {}, null)).toBeUndefined()
  })
})
