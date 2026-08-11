import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Point the profile loader at a controlled vocab so the matcher is deterministic.
const PROFILE_PATH = resolve(tmpdir(), `cos-vocab-echo-${process.pid}.json`)

let isVocabEchoOnly: (t: string) => boolean
let countVocabTerms: (t: string) => number

beforeAll(async () => {
  writeFileSync(PROFILE_PATH, JSON.stringify({
    owner_name: 'Miles Ukaoma',
    vocabulary: ['POSNation', 'ThriftCart', 'IT Retail', 'Bottle POS', 'Jewel360', 'Austin', 'Miles Ukaoma'],
    whisper_corrections: JSON.stringify({ 'POS Nation': 'POSNation', 'Thrift Cart': 'ThriftCart', 'Jewel 360': 'Jewel360', 'Myles': 'Miles' }),
    negative_rules: [],
  }))
  process.env.COS_PROFILE_PATH = PROFILE_PATH
  const mod = await import('./hallucination-filter.js')
  const profile = await import('./profile.js')
  profile.clearProfileCache()
  mod.resetVocabEchoCache()
  isVocabEchoOnly = mod.isVocabEchoOnly
  countVocabTerms = mod.countVocabTerms
})

afterAll(() => {
  delete process.env.COS_PROFILE_PATH
  try { unlinkSync(PROFILE_PATH) } catch {}
})

describe('vocab-echo (prompt regurgitation) detection', () => {
  it('flags a bare list of seeded brand names as echo-only', () => {
    expect(isVocabEchoOnly('POS Nation. Thrift Cart. IT Retail.')).toBe(true)
    expect(isVocabEchoOnly('POSNation ThriftCart IT Retail')).toBe(true)
    expect(isVocabEchoOnly('Jewel 360, Bottle POS')).toBe(true)  // correction-key spelling
  })

  it('does NOT flag real speech that mentions a brand in a sentence', () => {
    expect(isVocabEchoOnly('update the POS Nation pricing page')).toBe(false)
    expect(isVocabEchoOnly('POS Nation and Thrift Cart')).toBe(false)  // "and" is a content word
    expect(isVocabEchoOnly('we should review IT Retail today')).toBe(false)
    expect(isVocabEchoOnly('hello there team')).toBe(false)            // no vocab at all
  })

  it('EXCLUDES plain single-word terms so common words are never flagged (QA BLOCKER 1)', () => {
    // "Austin" (vocab) and "Miles" (a correction value) are plain words → excluded.
    expect(countVocabTerms('Austin')).toBe(0)
    expect(countVocabTerms('Miles')).toBe(0)
    expect(countVocabTerms('Austin Miles')).toBe(0)
    expect(isVocabEchoOnly('Austin')).toBe(false)
    expect(isVocabEchoOnly('Austin Miles')).toBe(false)
    expect(isVocabEchoOnly('a few miles outside Austin')).toBe(false)
    // Multi-word and brand-shaped terms ARE still matched.
    expect(countVocabTerms('Miles Ukaoma')).toBe(1)
    expect(countVocabTerms('POSNation')).toBe(1)
  })

  it('counts distinct seeded terms (spelling-insensitive)', () => {
    expect(countVocabTerms('POS Nation Thrift Cart IT Retail')).toBe(3)
    expect(countVocabTerms('POSNation POS Nation')).toBe(1)            // same term, two spellings
    expect(countVocabTerms('nothing seeded here')).toBe(0)
  })

  it('matcher is word-bounded (no sub-word matches)', () => {
    expect(countVocabTerms('Jewel3600')).toBe(0)         // \b after Jewel360 fails
    expect(isVocabEchoOnly('Austin-based planning')).toBe(false)
  })
})
