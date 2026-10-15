import { describe, expect, it } from 'vitest'
import {
  MAX_LOG,
  MAX_TERMS,
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
      ['a'.repeat(101), 'b', 'dictation', 400],
      ['a', 'b'.repeat(101), 'dictation', 400],
      ['a\nb', 'c', 'dictation', 400],
      ['same', 'same', 'dictation', 400],
      ['gotcos', 'gotcos.com', 'dictation', 400],
      ['slash', 'a/b', 'dictation', 400],
    ]
    for (const [heard, written, source, status] of bad) {
      const r = learnCorrection(words(), { heard, written, source }, stamp(1))
      expect(r.ok, JSON.stringify([heard, written, source])).toBe(false)
      if (!r.ok) expect(r.status).toBe(status)
    }
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
