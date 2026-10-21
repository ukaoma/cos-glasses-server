import { describe, expect, it } from 'vitest'
import {
  CORRECTION_ONLY_NOTE,
  correctionOnlyForms,
  decoderContextWindow,
  decoderSafeContext,
  isCorrectionOnly,
  MAX_LOG,
  MAX_TERMS,
  MAX_TERM_LEN,
  addVocabulary,
  removeCorrection,
  removeVocabulary,
  appendLog,
  learnCorrection,
  parseLog,
  undoCorrection,
  type CorrectionLogEntry,
  type GlossaryWords,
} from './glossary-learn.js'

const stamp = (n: number) => ({ id: `id-${n}`, at: `2026-10-15T18:${String(n).padStart(2, '0')}:00.000Z` })
const words = (vocabulary: string[] = [], corrections: Record<string, string> = {}): GlossaryWords => ({ vocabulary, corrections })

function learn(w: GlossaryWords, heard: string, written: string, n = 1, source = 'dictation') {
  const r = learnCorrection(w, { heard, written, source }, stamp(n))
  if (!r.ok || r.unchanged) throw new Error(`expected a change, got ${JSON.stringify(r)}`)
  return r
}

describe('learnCorrection', () => {
  it('adds heard → written and the spelling to the vocabulary in one result', () => {
    const r = learn(words(['Parakeet'], { Myles: 'Miles' }), ' Whisper ', ' Wispr ')
    expect(r.words.corrections).toEqual({ Myles: 'Miles', Whisper: 'Wispr' })
    expect(r.words.vocabulary).toEqual(['Parakeet', 'Wispr'])
    expect(r.entry).toEqual({ id: 'id-1', heard: 'Whisper', written: 'Wispr', source: 'dictation', at: stamp(1).at, replacedKey: null, previous: null, addedVocabulary: true })
  })

  it('dedupes the vocabulary case-insensitively', () => {
    const r = learn(words(['wispr']), 'Whisper', 'Wispr')
    expect(r.words.vocabulary).toEqual(['wispr'])
    expect(r.entry.addedVocabulary).toBe(false)
  })

  it('replaces a case-variant key instead of adding a second one, and remembers it', () => {
    const r = learn(words([], { whisper: 'Whisperer' }), 'Whisper', 'Wispr')
    expect(r.words.corrections).toEqual({ Whisper: 'Wispr' })
    expect(r.entry.replacedKey).toBe('whisper')
    expect(r.entry.previous).toBe('Whisperer')
  })

  it('reports an exact repeat as unchanged', () => {
    const r = learnCorrection(words(['Wispr'], { Whisper: 'Wispr' }), { heard: 'Whisper', written: 'Wispr', source: 'manual' }, stamp(1))
    expect(r).toEqual({ ok: true, unchanged: true })
  })

  it('refuses invalid input', () => {
    const bad: Array<[unknown, unknown, unknown, number]> = [
      [1, 'x', 'dictation', 400],
      ['a', 'b', 'email', 400],
      ['', 'b', 'dictation', 400],
      ['a', '   ', 'dictation', 400],
      ['a'.repeat(MAX_TERM_LEN + 1), 'b', 'dictation', 400],
      ['a', 'b'.repeat(MAX_TERM_LEN + 1), 'dictation', 400],
      ['a\nb', 'c', 'dictation', 400],
      ['same', 'same', 'dictation', 400],
      // 6.83.1: a link or path is allowed as a correction, but a bare symbol is not.
      ['slash', '/', 'dictation', 400],
      ['backslash', '\\', 'dictation', 400],
    ]
    for (const [heard, written, source, status] of bad) {
      const r = learnCorrection(words(), { heard, written, source }, stamp(1))
      expect(r.ok, JSON.stringify([heard, written, source])).toBe(false)
      if (!r.ok) expect(r.status).toBe(status)
    }
  })

  it('accepts exactly MAX_TERM_LEN UTF-16 units, the unit COS Control counts too', () => {
    expect(learnCorrection(words(), { heard: 'a'.repeat(MAX_TERM_LEN), written: 'b'.repeat(MAX_TERM_LEN), source: 'manual' }, stamp(1)).ok).toBe(true)
    // An emoji is two UTF-16 units: half as many fit.
    expect(learnCorrection(words(), { heard: '😀'.repeat(MAX_TERM_LEN / 2), written: 'b', source: 'manual' }, stamp(1)).ok).toBe(true)
    expect(learnCorrection(words(), { heard: '😀'.repeat(MAX_TERM_LEN / 2 + 1), written: 'b', source: 'manual' }, stamp(1)).ok).toBe(false)
  })

  it('accepts every source surface', () => {
    for (const source of ['dictation', 'meeting', 'g2', 'manual']) {
      expect(learnCorrection(words(), { heard: 'a', written: 'b', source }, stamp(1)).ok).toBe(true)
    }
  })

  it('respects the 500-term caps for new corrections and new vocabulary', () => {
    const full: Record<string, string> = {}
    for (let i = 0; i < MAX_TERMS; i++) full[`k${i}`] = `v${i}`
    const r1 = learnCorrection(words([], full), { heard: 'new', written: 'New', source: 'manual' }, stamp(1))
    expect(r1).toMatchObject({ ok: false, status: 409 })
    // Replacing an existing key is not a new entry, so a full map still accepts it.
    expect(learnCorrection(words([], full), { heard: 'K1', written: 'Fixed', source: 'manual' }, stamp(1)).ok).toBe(true)
    const vocab = Array.from({ length: MAX_TERMS }, (_, i) => `t${i}`)
    const r2 = learnCorrection(words(vocab), { heard: 'x', written: 'Brand New', source: 'manual' }, stamp(1))
    expect(r2).toMatchObject({ ok: false, status: 409 })
    expect(learnCorrection(words(vocab), { heard: 'x', written: 'T3', source: 'manual' }, stamp(1)).ok).toBe(true)
  })
})

describe('undoCorrection', () => {
  it('reverts exactly the entry: correction and the vocabulary it added', () => {
    const base = words(['Parakeet'], { Myles: 'Miles' })
    const r = learn(base, 'Whisper', 'Wispr')
    const log = appendLog([], r.entry)
    const u = undoCorrection(r.words, log, 'id-1')
    expect(u.ok).toBe(true)
    if (u.ok) {
      expect(u.words).toEqual(base)
      expect(u.log).toEqual([])
    }
  })

  it('puts a replaced case-variant back', () => {
    const base = words(['Whisperer'], { whisper: 'Whisperer' })
    const r = learn(base, 'Whisper', 'Wispr')
    const u = undoCorrection(r.words, [r.entry], 'id-1')
    expect(u.ok && u.words).toEqual(base)
  })

  it('keeps a spelling another correction still writes', () => {
    const a = learn(words(), 'Whisper', 'Wispr', 1)
    const b = learn(a.words, 'Wisper', 'Wispr', 2)
    expect(b.entry.addedVocabulary).toBe(false)
    const u = undoCorrection(b.words, [b.entry, a.entry], 'id-1')
    expect(u.ok).toBe(true)
    if (u.ok) {
      expect(u.words.corrections).toEqual({ Wisper: 'Wispr' })
      expect(u.words.vocabulary).toEqual(['Wispr'])
    }
  })

  it('refuses when the word changed since, or a newer entry owns it', () => {
    const a = learn(words(), 'Whisper', 'Wispr', 1)
    const edited = { ...a.words, corrections: { Whisper: 'Whispr' } }
    expect(undoCorrection(edited, [a.entry], 'id-1')).toMatchObject({ ok: false, status: 409 })
    const b = learn(a.words, 'whisper', 'Wispr Flow', 2)
    expect(undoCorrection(b.words, [b.entry, a.entry], 'id-1')).toMatchObject({ ok: false, status: 409 })
    // The newest one still undoes, and gives the older value back.
    const u = undoCorrection(b.words, [b.entry, a.entry], 'id-2')
    expect(u.ok && u.words.corrections).toEqual({ Whisper: 'Wispr' })
  })

  it('refuses an older entry whose value a newer entry happens to restore', () => {
    // Value equality alone would pass here: Whisper is Wispr again, but entry 3 owns it now.
    const a = learn(words(), 'Whisper', 'Wispr', 1)
    const b = learn(a.words, 'Whisper', 'Wispr Flow', 2)
    const c = learn(b.words, 'Whisper', 'Wispr', 3)
    expect(c.words.corrections).toEqual({ Whisper: 'Wispr' })
    expect(undoCorrection(c.words, [c.entry, b.entry, a.entry], 'id-1')).toMatchObject({ ok: false, status: 409 })
  })

  it('refuses an unknown or missing id', () => {
    expect(undoCorrection(words(), [], 'nope')).toMatchObject({ ok: false, status: 404 })
    expect(undoCorrection(words(), [], undefined)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('log', () => {
  it('is newest first and bounded', () => {
    let log: CorrectionLogEntry[] = []
    for (let i = 0; i < MAX_LOG + 5; i++) log = appendLog(log, { ...learn(words(), 'a', 'b', 1).entry, id: `n${i}` })
    expect(log).toHaveLength(MAX_LOG)
    expect(log[0].id).toBe(`n${MAX_LOG + 4}`)
  })

  it('parses tolerantly and drops malformed rows', () => {
    const good = learn(words(), 'a', 'b').entry
    expect(parseLog(null)).toEqual([])
    expect(parseLog({ entries: 'x' })).toEqual([])
    expect(parseLog({ entries: [good, { id: 1 }, { ...good, source: 'email' }, null] })).toEqual([good])
  })
})

describe('single-item edits (6.73.12)', () => {
  it('adds one word, dedupes case-insensitively, refuses URL and over-long words', () => {
    const r = addVocabulary(words(['Parakeet'], { Myles: 'Miles' }), ' Wispr ')
    expect(r).toEqual({ ok: true, unchanged: false, words: { vocabulary: ['Parakeet', 'Wispr'], corrections: { Myles: 'Miles' } } })
    expect(addVocabulary(words(['wispr']), 'Wispr')).toEqual({ ok: true, unchanged: true })
    expect(addVocabulary(words(), 'gotcos.com')).toMatchObject({ ok: false, status: 400 })
    // 6.83.1: a vocabulary word has no heard side, so a link or path there is only decoder risk.
    for (const term of ['/pricing', 'sam@example.com', 'https://example.com']) {
      const r = addVocabulary(words(), term)
      expect(r).toMatchObject({ ok: false, status: 400 })
      if (!r.ok) expect(r.error).toContain('Add it as a correction instead')
    }
    expect(addVocabulary(words(), 'a'.repeat(MAX_TERM_LEN)).ok).toBe(true)
    expect(addVocabulary(words(), 'a'.repeat(MAX_TERM_LEN + 1))).toMatchObject({ ok: false, status: 400 })
    expect(addVocabulary(words(), 'a\nb')).toMatchObject({ ok: false, status: 400 })
    expect(addVocabulary(words(), 7)).toMatchObject({ ok: false, status: 400 })
  })

  it('respects the vocabulary cap but lets an existing word through', () => {
    const full = Array.from({ length: MAX_TERMS }, (_, i) => `t${i}`)
    expect(addVocabulary(words(full), 'New Word')).toMatchObject({ ok: false, status: 409 })
    expect(addVocabulary(words(full), 'T4')).toEqual({ ok: true, unchanged: true })
  })

  it('removes the exact word only', () => {
    expect(removeVocabulary(words(['Wispr', 'wispr flow']), 'Wispr')).toEqual({ ok: true, unchanged: false, words: { vocabulary: ['wispr flow'], corrections: {} } })
    expect(removeVocabulary(words(['Wispr']), 'wispr')).toEqual({ ok: true, unchanged: true })
    expect(removeVocabulary(words(['Wispr']), '')).toMatchObject({ ok: false, status: 400 })
  })

  it('removes a correction by its key, else its case variant, and leaves the rest', () => {
    const base = words(['Miles'], { Myles: 'Miles', 'carrot iq': 'CaratIQ' })
    expect(removeCorrection(base, 'Myles')).toEqual({ ok: true, unchanged: false, words: { vocabulary: ['Miles'], corrections: { 'carrot iq': 'CaratIQ' } } })
    expect(removeCorrection(base, 'Carrot IQ')).toEqual({ ok: true, unchanged: false, words: { vocabulary: ['Miles'], corrections: { Myles: 'Miles' } } })
    expect(removeCorrection(base, 'nope')).toEqual({ ok: true, unchanged: true })
  })
})

// 6.83.1. Miles, 2026-10-21: "forward slash pricing" written "/pricing" was refused because the
// written form "would join the decoder prompt". It now joins the corrections only.
describe('correction-only written forms (links, emails, paths)', () => {
  it('stores "/pricing" as a correction and never in the vocabulary', () => {
    const before = words(['Quilt'], { Myles: 'Miles' })
    const r = learn(before, 'forward slash pricing', '/pricing')
    expect(r.words.corrections).toEqual({ Myles: 'Miles', 'forward slash pricing': '/pricing' })
    expect(r.words.vocabulary).toEqual(['Quilt'])
    expect(r.entry.addedVocabulary).toBe(false)
    expect(before.vocabulary).toEqual(['Quilt'])
  })

  it('accepts slugs, URLs, domains, emails and file paths the same way', () => {
    for (const [heard, written] of [
      ['forward slash build and price', '/build-and-price'],
      ['bottle pos dot com', 'bottlepos.com'],
      ['sam at example dot com', 'sam@example.com'],
      ['example site', 'https://example.com/demo'],
      ['docs path', 'docs/setup.md'],
    ]) {
      const r = learn(words(['Quilt']), heard, written)
      expect(r.words.corrections[heard], heard).toBe(written)
      expect(r.words.vocabulary, heard).toEqual(['Quilt'])
      expect(r.entry.addedVocabulary, heard).toBe(false)
      expect(isCorrectionOnly(written), written).toBe(true)
    }
  })

  it('an exact repeat is unchanged even though the spelling is not in the vocabulary', () => {
    const r = learnCorrection(words([], { 'forward slash pricing': '/pricing' }), { heard: 'forward slash pricing', written: '/pricing', source: 'dictation' }, stamp(2))
    expect(r).toEqual({ ok: true, unchanged: true })
  })

  it('a full vocabulary does not block a correction-only learn; a full corrections map still does', () => {
    const fullVocab = Array.from({ length: MAX_TERMS }, (_, i) => `T${i}`)
    expect(learn(words(fullVocab), 'forward slash pricing', '/pricing').words.vocabulary).toHaveLength(MAX_TERMS)
    expect(learnCorrection(words(fullVocab), { heard: 'Whisper', written: 'Wispr', source: 'manual' }, stamp(1))).toMatchObject({ ok: false, status: 409 })
    const fullCorrections = Object.fromEntries(fullVocab.map(t => [t, t.toLowerCase()]))
    expect(learnCorrection(words([], fullCorrections), { heard: 'forward slash pricing', written: '/pricing', source: 'manual' }, stamp(1))).toMatchObject({ ok: false, status: 409 })
  })

  it('undo takes the correction back out and leaves the vocabulary alone', () => {
    const start = words(['Quilt', '/legacy-never-written-by-this-entry'], {})
    const r = learn(start, 'forward slash pricing', '/pricing', 1)
    const log = appendLog([], r.entry)
    const undone = undoCorrection(r.words, log, r.entry.id)
    if (!undone.ok) throw new Error(undone.error)
    expect(undone.words).toEqual(start)
    expect(undone.log).toEqual([])
  })

  it('undo of a correction-only entry that replaced an older spelling puts the older one back', () => {
    const r = learn(words(['Pricing Page'], { 'pricing page': 'Pricing Page' }), 'Pricing Page', '/pricing', 1)
    expect(r.entry).toMatchObject({ replacedKey: 'pricing page', previous: 'Pricing Page', addedVocabulary: false })
    const undone = undoCorrection(r.words, appendLog([], r.entry), r.entry.id)
    if (!undone.ok) throw new Error(undone.error)
    expect(undone.words).toEqual({ vocabulary: ['Pricing Page'], corrections: { 'pricing page': 'Pricing Page' } })
  })

  it('the note a client shows has no em dash or arrow', () => {
    expect(CORRECTION_ONLY_NOTE).not.toMatch(/[\u2014\u2192]/)
    expect(CORRECTION_ONLY_NOTE).toContain('never added to the words that guide transcription')
  })

  it('lists correction-only forms and puts the spoken form back in decoder context', () => {
    const corrections = { Myles: 'Miles', 'forward slash pricing': '/pricing', 'forward slash build and price': '/build-and-price', 'sam at example dot com': 'sam@example.com' }
    expect(correctionOnlyForms(corrections)).toEqual(['/pricing', '/build-and-price', 'sam@example.com'])
    expect(decoderSafeContext('Miles moved /pricing and /build-and-price, mail sam@example.com.', corrections))
      .toBe('Miles moved forward slash pricing and forward slash build and price, mail sam at example dot com.')
    expect(decoderSafeContext('nothing here', corrections)).toBe('nothing here')
    // The longer form goes back first, so a shorter form inside it cannot split it.
    const nested = { 'forward slash build': '/build', 'forward slash build and price': '/build-and-price' }
    expect(decoderSafeContext('see /build-and-price and /build', nested)).toBe('see forward slash build and price and forward slash build')
    // A pair whose heard side is itself a path is not put back (nothing spoken to restore).
    expect(decoderSafeContext('see /a', { '/b': '/a' })).toBe('see /a')
  })
})

describe('6.83.1 QA: handles, shared TLDs, any-case swap, the decoder window', () => {
  it('a handle is a link: correction only, never a vocabulary word', () => {
    expect(isCorrectionOnly('@sam')).toBe(true)
    expect(isCorrectionOnly('@quilt_hq')).toBe(true)
    expect(isCorrectionOnly('example.uk')).toBe(true)
    expect(isCorrectionOnly('sam@example.com')).toBe(true)
    for (const plain of ['AT&T', 'Jewel360', 'Bottle POS', 'Q3 @ 5', 'U.S.']) expect(isCorrectionOnly(plain), plain).toBe(false)
    expect(learn(words(['Quilt']), 'at sam', '@sam').words.vocabulary).toEqual(['Quilt'])
    expect(addVocabulary(words(), '@sam')).toMatchObject({ ok: false, status: 400 })
  })

  it('puts the spoken form back in any case', () => {
    const corrections = { 'forward slash pricing': '/pricing', 'sam at example dot com': 'sam@example.com' }
    expect(decoderSafeContext('see /Pricing and SAM@EXAMPLE.COM', corrections)).toBe('see forward slash pricing and sam at example dot com')
  })

  it('swaps before the cut, so a link split by the 250-character window leaves no tail', () => {
    const corrections = { 'sam at example dot com': 'sam@example.com' }
    const text = `${'word '.repeat(60)}mail sam@example.com ${'tail '.repeat(48)}`.trim()
    expect(text.slice(-250)).toMatch(/^[^ ]*\.com/)
    const window = decoderContextWindow(text, corrections)!
    expect(window.length).toBeLessThanOrEqual(250)
    expect(window).not.toMatch(/@|\.com/)
    expect(window).toContain('dot com')
    // A link the speaker said that is not in the dictionary: its split tail is dropped.
    const raw = `${'word '.repeat(60)}see bottlepos.com ${'tail '.repeat(48)}`.trim()
    expect(raw.slice(-250)).toMatch(/^[^ ]*\.com/)
    expect(decoderContextWindow(raw, {})!).not.toMatch(/\.com/)
    // A split ordinary word stays, as before 6.83.1.
    const plain = `${'alpha '.repeat(80)}`.trim()
    expect(decoderContextWindow(plain, {})).toBe(plain.slice(-250))
    expect(decoderContextWindow('short', corrections)).toBe('short')
    expect(decoderContextWindow(undefined, corrections)).toBeUndefined()
  })
})
