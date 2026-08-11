import { describe, expect, it } from 'vitest'
import { parseNegativeRules, applyNegativeRules, validateNegativeRule } from './hallucination-filter.js'

describe('negative rules', () => {
  it('drops whole lines (whole: and bare) that contain the literal', () => {
    expect(applyNegativeRules('keep me\nsubscribe now please\nkeep me too', ['whole:subscribe now']))
      .toBe('keep me\nkeep me too')
    expect(applyNegativeRules('a\nbadphrase here\nb', ['badphrase'])).toBe('a\nb')
  })

  it('strips and replaces inline, preserving the rest of the line', () => {
    expect(applyNegativeRules('um hello um world', ['strip:um'])).toBe('hello world')
    expect(applyNegativeRules('POS Nation rocks', ['replace:POS Nation=>POSNation'])).toBe('POSNation rocks')
  })

  it('respects word boundaries for word patterns', () => {
    // "um" should not be stripped from "summary"
    expect(applyNegativeRules('a summary um b', ['strip:um'])).toBe('a summary b')
  })

  it('flag is a no-op on the text', () => {
    expect(applyNegativeRules('flag this please', ['flag:flag this'])).toBe('flag this please')
  })

  it('never empties a non-empty input', () => {
    expect(applyNegativeRules('only this line', ['whole:only this line'])).toBe('only this line')
  })

  it('treats patterns literally — no ReDoS / regex injection', () => {
    expect(applyNegativeRules('x (a+)+ y', ['strip:(a+)+'])).toBe('x y')
    expect(applyNegativeRules('aaaaaaaaaa', ['strip:(a+)+'])).toBe('aaaaaaaaaa')
  })

  it('ignores comments and blank lines', () => {
    expect(parseNegativeRules(['# comment', '', '  '])).toHaveLength(0)
  })

  it('validates rules for the PUT', () => {
    expect(validateNegativeRule('whole:foo').ok).toBe(true)
    expect(validateNegativeRule('replace:a=>b').ok).toBe(true)
    expect(validateNegativeRule('bare phrase').ok).toBe(true)
    expect(validateNegativeRule('replace:missing-arrow').ok).toBe(false)
    expect(validateNegativeRule('strip:').ok).toBe(false)
    expect(validateNegativeRule('x'.repeat(201)).ok).toBe(false)
  })
})
