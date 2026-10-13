import { describe, expect, it } from 'vitest'
import { isDeletionProneEngine, isProtectedKey, MAX_ALIGNMENT_CELLS, resolveHypotheses, wordKey, type HypWord } from './stt-resolver.js'

const timed = (text: string, start = 0, step = 0.4): HypWord[] =>
  text.split(' ').map((word, i) => ({ word, start: start + i * step, end: start + i * step + step * 0.8 }))

const opts = (over: Partial<Parameters<typeof resolveHypotheses>[2]> = {}) => ({ vocabulary: [], primaryDeletionProne: true, apply: true, ...over })

describe('stt resolver', () => {
  it('fills a gap a deletion-prone primary left, and records it', () => {
    const r = resolveHypotheses(
      { engine: 'large-v3', text: 'we should ship', words: timed('we should ship') },
      { engine: 'parakeet-ultra', text: 'we should ship the build on Friday', words: timed('we should ship the build on Friday') },
      opts(),
    )
    expect(r.text).toBe('we should ship the build on Friday')
    expect(r.wordsFromSecond).toBe(4)
    expect(r.disagreements).toEqual([expect.objectContaining({ kind: 'second_only', second: 'the build on Friday', taken: 'second', reason: 'gap_fill' })])
    expect(r.timed).toBe(true)
  })

  it('never gap-fills for a primary that is not deletion-prone', () => {
    const r = resolveHypotheses(
      { engine: 'parakeet-ultra', text: 'we should ship', words: timed('we should ship') },
      { engine: 'large-v3', text: 'we should ship the build on Friday', words: timed('we should ship the build on Friday') },
      opts({ primaryDeletionProne: false }),
    )
    expect(r.text).toBe('we should ship')
    expect(r.disagreements[0]).toMatchObject({ kind: 'second_only', taken: 'primary', reason: null })
  })

  it('keeps the primary on a substitution unless the second side holds a vocabulary term', () => {
    const plain = resolveHypotheses({ engine: 'parakeet-ultra', text: 'call thrift card today' }, { engine: 'large-v3', text: 'call ThriftCart today' }, opts({ primaryDeletionProne: false, vocabulary: ['ThriftCart'] }))
    expect(plain.text).toBe('call ThriftCart today')
    expect(plain.disagreements[0]).toMatchObject({ kind: 'substitution', taken: 'second', reason: 'vocabulary' })
    const none = resolveHypotheses({ engine: 'parakeet-ultra', text: 'call thrift card today' }, { engine: 'large-v3', text: 'call ThriftCart today' }, opts({ primaryDeletionProne: false, vocabulary: [] }))
    expect(none.text).toBe('call thrift card today')
  })

  it('counts a split spelling of a vocabulary term as the term', () => {
    const r = resolveHypotheses({ engine: 'parakeet-ultra', text: 'on drift cart now' }, { engine: 'large-v3', text: 'on thrift cart now' }, opts({ primaryDeletionProne: false, vocabulary: ['ThriftCart', 'Thrift Cart'] }))
    expect(r.text).toBe('on thrift cart now')
  })

  it('never flips a negation or a unit on a substitution, even for vocabulary', () => {
    // "Quilt" sits beside the flip, so the vocabulary rescue wants this region. It is refused.
    const neg = resolveHypotheses({ engine: 'parakeet-ultra', text: 'born lacking Quilt bacteria' }, { engine: 'large-v3', text: 'born having QuiltSoftware bacteria' }, opts({ primaryDeletionProne: false, vocabulary: ['QuiltSoftware'] }))
    expect(neg.text).toBe('born lacking Quilt bacteria')
    expect(neg.disagreements[0]).toMatchObject({ kind: 'substitution', taken: 'primary', reason: 'protected' })
    const unit = resolveHypotheses({ engine: 'parakeet-ultra', text: 'around 18 months for POS' }, { engine: 'large-v3', text: 'around 18 minutes for PosNation' }, opts({ primaryDeletionProne: false, vocabulary: ['PosNation'] }))
    expect(unit.text).toBe('around 18 months for PosNation') // the unit stays; the separate name region is rescued
    expect(unit.disagreements[0]).toMatchObject({ second: 'minutes', taken: 'primary' })
    const joined = resolveHypotheses({ engine: 'parakeet-ultra', text: 'around 18 months POS today' }, { engine: 'large-v3', text: 'around 18 minutes PosNation today' }, opts({ primaryDeletionProne: false, vocabulary: ['PosNation'] }))
    expect(joined.text).toBe('around 18 months POS today')
    expect(joined.disagreements[0]).toMatchObject({ taken: 'primary', reason: 'protected' })
  })

  it('refuses a short gap fill that would insert a negation or a number', () => {
    const r = resolveHypotheses({ engine: 'large-v3', text: 'we are going today' }, { engine: 'parakeet-ultra', text: 'we are not going today' }, opts())
    expect(r.text).toBe('we are going today')
    expect(r.disagreements[0]).toMatchObject({ kind: 'second_only', taken: 'primary', reason: 'protected' })
    const n = resolveHypotheses({ engine: 'large-v3', text: 'about dollars' }, { engine: 'parakeet-ultra', text: 'about 40 dollars' }, opts())
    expect(n.text).toBe('about dollars')
  })

  it('accepts a long dropped run even when it holds a negation (new content, not a flip)', () => {
    const r = resolveHypotheses({ engine: 'large-v3', text: 'okay then' }, { engine: 'parakeet-ultra', text: 'okay then we do not have the budget yet' }, opts())
    expect(r.text).toBe('okay then we do not have the budget yet')
  })

  it('records disagreements but changes nothing when apply is false', () => {
    const r = resolveHypotheses({ engine: 'large-v3', text: 'we should ship' }, { engine: 'parakeet-ultra', text: 'we should ship the build on Friday' }, opts({ apply: false }))
    expect(r.text).toBe('we should ship')
    expect(r.wordsFromSecond).toBe(0)
    expect(r.disagreements[0]).toMatchObject({ taken: 'primary', reason: 'gap_fill' })
    expect(r.applied).toBe(false)
  })

  it('with a skew limit, never pairs words that are far apart in time', () => {
    const p = [{ word: 'alpha', start: 0, end: 0.3 }, { word: 'beta', start: 0.4, end: 0.6 }]
    const q = [{ word: 'alpha', start: 9, end: 9.3 }, { word: 'beta', start: 9.4, end: 9.6 }]
    const r = resolveHypotheses({ engine: 'large-v3', text: 'alpha beta', words: p }, { engine: 'parakeet-ultra', text: 'alpha beta', words: q }, opts({ maxSkewSec: 2 }))
    expect(r.disagreements.length).toBeGreaterThan(0)
    // Off by default (measured: any limit made the resolver worse on real clocks).
    expect(resolveHypotheses({ engine: 'large-v3', text: 'alpha beta', words: p }, { engine: 'parakeet-ultra', text: 'alpha beta', words: q }, opts()).disagreements).toEqual([])
    const same = resolveHypotheses({ engine: 'large-v3', text: 'alpha beta', words: p }, { engine: 'parakeet-ultra', text: 'alpha beta', words: p }, opts())
    expect(same.disagreements).toEqual([])
  })

  it('treats punctuation and case as the same word', () => {
    expect(wordKey("Don't,")).toBe('dont')
    expect(resolveHypotheses({ engine: 'large-v3', text: 'Hello, world.' }, { engine: 'parakeet-ultra', text: 'hello world' }, opts()).disagreements).toEqual([])
  })

  it('skips alignment that would be too large and keeps the primary', () => {
    const n = Math.ceil(Math.sqrt(MAX_ALIGNMENT_CELLS)) + 1
    const long = Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
    const r = resolveHypotheses({ engine: 'large-v3', text: long }, { engine: 'parakeet-ultra', text: `${long} extra` }, opts())
    expect(r.skipped).toBe('too_long')
    expect(r.text).toBe(long)
  })

  it('knows which engines are deletion-prone and which words are protected', () => {
    expect(isDeletionProneEngine('large-v3')).toBe(true)
    expect(isDeletionProneEngine('large-v3-legacy')).toBe(true)
    expect(isDeletionProneEngine('parakeet-ultra')).toBe(false)
    for (const k of ['not', 'never', 'lacking', 'months', 'minutes', '18', 'eighteen', 'percent']) expect(isProtectedKey(k)).toBe(true)
    for (const k of ['am', 'one', 'second', 'first', 'having', 'the']) expect(isProtectedKey(k)).toBe(false)
  })
})
