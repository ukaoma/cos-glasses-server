// One-word dictionary learning (6.73.11). "Fix a word" in COS Control, and any
// other surface, teaches ONE correction at a time: heard → written joins the
// corrections map and `written` joins the vocabulary, in one write. Since 6.83.1 a
// written form that is a link, email or path ("forward slash pricing" written
// "/pricing") is kept as a correction ONLY: it never joins the vocabulary, so it
// never reaches a decoder prompt. Every learn
// is logged (bounded, newest first) so the person can see what COS learned, from
// where, and undo exactly that one entry.
//
// Pure: no IO. The route in routes/glossary.ts reads the profile and the log,
// calls these, and writes both back inside the glossary write chain.

export const MAX_TERMS = 500
export const MAX_TERM_LEN = 100
export const MAX_LOG = 200
export const CORRECTION_SOURCES = ['dictation', 'meeting', 'g2', 'manual'] as const
export type CorrectionSource = typeof CORRECTION_SOURCES[number]

export interface GlossaryWords {
  vocabulary: string[]
  corrections: Record<string, string>
}

export interface CorrectionLogEntry {
  id: string
  heard: string
  written: string
  source: CorrectionSource
  at: string
  /** The existing key this entry replaced (a case variant of `heard`, or `heard` itself), or null. */
  replacedKey: string | null
  /** What `replacedKey` mapped to before this entry, or null. */
  previous: string | null
  /** True when this entry put `written` into the vocabulary. */
  addedVocabulary: boolean
}

export type LearnResult =
  | { ok: true; unchanged: true }
  | { ok: true; unchanged: false; words: GlossaryWords; entry: CorrectionLogEntry }
  | { ok: false; status: number; error: string }

export type UndoResult =
  | { ok: true; words: GlossaryWords; log: CorrectionLogEntry[]; entry: CorrectionLogEntry }
  | { ok: false; status: number; error: string }

// Positive vocab is injected into the Whisper decoder prompt; URLs/emails/paths
// there induce ".com"/handle hallucinations on quiet audio, so they never join the
// vocabulary. As a correction's written form they are fine (6.83.1): corrections are
// applied to text after decoding and are not part of any decoder prompt.
export function looksLikeUrlEmailPath(s: string): boolean {
  return /(?:https?:\/\/|www\.)/i.test(s)
    || /@[\w.-]+\.\w/.test(s)
    || /\.(?:com|net|org|io|ai|co|gov|edu|app|dev)\b/i.test(s)
    || /[/\\]/.test(s)
}

const CONTROL = /[\u0000-\u001f\u007f]/
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function isCorrectionSource(value: unknown): value is CorrectionSource {
  return typeof value === 'string' && (CORRECTION_SOURCES as readonly string[]).includes(value)
}

export function learnCorrection(
  words: GlossaryWords,
  input: { heard: unknown; written: unknown; source: unknown },
  stamp: { id: string; at: string },
): LearnResult {
  if (typeof input.heard !== 'string' || typeof input.written !== 'string') {
    return { ok: false, status: 400, error: 'heard and written must be strings' }
  }
  if (!isCorrectionSource(input.source)) {
    return { ok: false, status: 400, error: `source must be one of ${CORRECTION_SOURCES.join(', ')}` }
  }
  const heard = input.heard.trim()
  const written = input.written.trim()
  if (!heard || !written) return { ok: false, status: 400, error: 'heard and written must not be empty' }
  if (heard.length > MAX_TERM_LEN || written.length > MAX_TERM_LEN) {
    return { ok: false, status: 400, error: `a correction is at most ${MAX_TERM_LEN} characters` }
  }
  if (CONTROL.test(heard) || CONTROL.test(written)) {
    return { ok: false, status: 400, error: 'a correction cannot contain line breaks or control characters' }
  }
  if (heard === written) return { ok: false, status: 400, error: 'the written spelling is the same as what was heard' }
  // 6.83.1: a link, email or path is a correction only (see correctionOnly).
  const correctionOnly = isCorrectionOnly(written)
  if (correctionOnly && !/[\p{L}\p{N}]/u.test(written)) {
    // "/" or "@" alone rewrites every "slash" or "at" in every transcript: no word to anchor it.
    return { ok: false, status: 400, error: 'the written spelling needs a letter or number; a bare symbol would rewrite every sentence that says it' }
  }

  const existingKey = Object.keys(words.corrections).find(key => same(key, heard)) ?? null
  const correctionChanged = existingKey !== heard || words.corrections[heard] !== written
  const inVocabulary = words.vocabulary.some(term => same(term, written))
  if (!correctionChanged && (inVocabulary || correctionOnly)) return { ok: true, unchanged: true }

  if (existingKey === null && Object.keys(words.corrections).length >= MAX_TERMS) {
    return { ok: false, status: 409, error: `the dictionary already holds ${MAX_TERMS} corrections; remove one first` }
  }
  const addsVocabulary = !inVocabulary && !correctionOnly
  if (addsVocabulary && words.vocabulary.length >= MAX_TERMS) {
    return { ok: false, status: 409, error: `the vocabulary already holds ${MAX_TERMS} terms; remove one first` }
  }

  const corrections = { ...words.corrections }
  if (existingKey !== null && existingKey !== heard) delete corrections[existingKey]
  corrections[heard] = written
  const vocabulary = addsVocabulary ? [...words.vocabulary, written] : [...words.vocabulary]
  const entry: CorrectionLogEntry = {
    id: stamp.id,
    heard,
    written,
    source: input.source,
    at: stamp.at,
    replacedKey: existingKey,
    previous: existingKey === null ? null : words.corrections[existingKey],
    addedVocabulary: addsVocabulary,
  }
  return { ok: true, unchanged: false, words: { vocabulary, corrections }, entry }
}

/**
 * 6.83.1: a written form that is a link, email or path is kept in the corrections map
 * and never added to the vocabulary (the decoder prompt). Same test as the vocabulary
 * guard, so nothing the decoder refuses can reach it through a correction.
 */
export function isCorrectionOnly(written: string): boolean {
  return looksLikeUrlEmailPath(written)
}

/** The one line a client can show after a correction-only learn. No em dashes, no arrows. */
export const CORRECTION_ONLY_NOTE = 'Saved as a correction. Links, emails and paths are never added to the words that guide transcription, so COS rewrites what it hears instead.'

/**
 * The written forms of correction-only entries ("/pricing"), for callers that may use
 * them as known spellings outside the decoder (the AI polish prompt), and for
 * decoderSafeContext below.
 */
export function correctionOnlyForms(corrections: Record<string, string>): string[] {
  const out: string[] = []
  for (const value of Object.values(corrections)) {
    const v = value.trim()
    if (v && isCorrectionOnly(v) && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * The rolling transcript context Whisper is primed with already holds corrected text, so
 * a correction-only form ("/pricing") would reach the decoder through it. Put the spoken
 * form back ("forward slash pricing") before priming: the decoder hears words, never the
 * link or path. Longest forms first so "/build-and-price" is not split by "/build".
 */
export function decoderSafeContext(context: string, corrections: Record<string, string>): string {
  const pairs = Object.entries(corrections)
    .map(([heard, written]) => [heard.trim(), written.trim()] as const)
    .filter(([heard, written]) => heard && written && isCorrectionOnly(written) && !isCorrectionOnly(heard))
    .sort((a, b) => b[1].length - a[1].length)
  let out = context
  for (const [heard, written] of pairs) out = out.split(written).join(heard)
  return out
}

/** Newest first, bounded. */
export function appendLog(log: CorrectionLogEntry[], entry: CorrectionLogEntry): CorrectionLogEntry[] {
  return [entry, ...log].slice(0, MAX_LOG)
}

/**
 * Revert exactly one logged entry, and only while the dictionary still says
 * what that entry wrote. A later entry for the same word, or a hand edit since,
 * makes the undo refuse rather than clobber the newer choice.
 */
export function undoCorrection(words: GlossaryWords, log: CorrectionLogEntry[], id: unknown): UndoResult {
  if (typeof id !== 'string' || !id) return { ok: false, status: 400, error: 'id is required' }
  const index = log.findIndex(entry => entry.id === id)
  if (index < 0) return { ok: false, status: 404, error: 'that correction is no longer in the recent list' }
  const entry = log[index]
  if (log.slice(0, index).some(newer => same(newer.heard, entry.heard))) {
    return { ok: false, status: 409, error: `a newer correction changed "${entry.heard}"; undo that one first` }
  }
  if (words.corrections[entry.heard] !== entry.written) {
    return { ok: false, status: 409, error: `"${entry.heard}" was changed since; edit it in the dictionary instead` }
  }
  const corrections = { ...words.corrections }
  delete corrections[entry.heard]
  if (entry.replacedKey !== null && entry.previous !== null) {
    const collision = Object.keys(corrections).some(key => same(key, entry.replacedKey!))
    if (collision) return { ok: false, status: 409, error: `"${entry.replacedKey}" was changed since; edit it in the dictionary instead` }
    corrections[entry.replacedKey] = entry.previous
  }
  let vocabulary = [...words.vocabulary]
  // The spelling stays while any remaining correction still writes it.
  if (entry.addedVocabulary && !Object.values(corrections).some(value => same(value, entry.written))) {
    vocabulary = vocabulary.filter(term => !same(term, entry.written))
  }
  return { ok: true, words: { vocabulary, corrections }, log: log.filter((_, i) => i !== index), entry }
}

/** Tolerant reader: a missing or corrupt log is an empty one; malformed rows are dropped. */
export function parseLog(raw: unknown): CorrectionLogEntry[] {
  const entries = raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
    ? (raw as { entries: unknown[] }).entries : []
  const out: CorrectionLogEntry[] = []
  for (const value of entries) {
    if (!value || typeof value !== 'object') continue
    const e = value as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.heard !== 'string' || typeof e.written !== 'string'
      || !isCorrectionSource(e.source) || typeof e.at !== 'string' || typeof e.addedVocabulary !== 'boolean') continue
    const replacedKey = typeof e.replacedKey === 'string' ? e.replacedKey : null
    const previous = typeof e.previous === 'string' ? e.previous : null
    out.push({ id: e.id, heard: e.heard, written: e.written, source: e.source, at: e.at, replacedKey, previous, addedVocabulary: e.addedVocabulary })
    if (out.length >= MAX_LOG) break
  }
  return out
}

// ── Single-item edits (6.73.12) ──────────────────────────────────────────────
// COS Control's Dictionary pane adds or removes ONE word or correction. Each is a
// pure step over the stored words, run inside the glossary write chain, so a
// concurrent learn can never be lost the way a client read-then-PUT could lose it.
// These are hand edits; they are not logged for undo.

export type EditResult =
  | { ok: true; unchanged: true }
  | { ok: true; unchanged: false; words: GlossaryWords }
  | { ok: false; status: number; error: string }

function validTerm(raw: unknown, what: string): { ok: true; value: string } | { ok: false; status: number; error: string } {
  if (typeof raw !== 'string') return { ok: false, status: 400, error: `${what} must be a string` }
  const value = raw.trim()
  if (!value) return { ok: false, status: 400, error: `${what} must not be empty` }
  if (value.length > MAX_TERM_LEN) return { ok: false, status: 400, error: `${what} is at most ${MAX_TERM_LEN} characters` }
  if (CONTROL.test(value)) return { ok: false, status: 400, error: `${what} cannot contain line breaks or control characters` }
  return { ok: true, value }
}

export function addVocabulary(words: GlossaryWords, raw: unknown): EditResult {
  const term = validTerm(raw, 'term')
  if (!term.ok) return term
  if (looksLikeUrlEmailPath(term.value)) {
    // A vocabulary word has no heard side: it only steers the decoder, which is exactly
    // where a link, email or path does harm. Point at the correction that does work.
    return { ok: false, status: 400, error: 'a link, email or path cannot be a vocabulary word because it would steer transcription. Add it as a correction instead: what you say, then how to write it' }
  }
  if (words.vocabulary.some(existing => same(existing, term.value))) return { ok: true, unchanged: true }
  if (words.vocabulary.length >= MAX_TERMS) {
    return { ok: false, status: 409, error: `the vocabulary already holds ${MAX_TERMS} terms; remove one first` }
  }
  return { ok: true, unchanged: false, words: { vocabulary: [...words.vocabulary, term.value], corrections: { ...words.corrections } } }
}

/** Removes the exact word; a word that is not there is not an error. */
export function removeVocabulary(words: GlossaryWords, raw: unknown): EditResult {
  const term = validTerm(raw, 'term')
  if (!term.ok) return term
  const vocabulary = words.vocabulary.filter(existing => existing.trim() !== term.value)
  if (vocabulary.length === words.vocabulary.length) return { ok: true, unchanged: true }
  return { ok: true, unchanged: false, words: { vocabulary, corrections: { ...words.corrections } } }
}

/** Removes the correction for `heard` (its exact key, else its one case variant). */
export function removeCorrection(words: GlossaryWords, raw: unknown): EditResult {
  const heard = validTerm(raw, 'heard')
  if (!heard.ok) return heard
  const key = heard.value in words.corrections
    ? heard.value
    : Object.keys(words.corrections).find(existing => same(existing, heard.value))
  if (key === undefined) return { ok: true, unchanged: true }
  const corrections = { ...words.corrections }
  delete corrections[key]
  return { ok: true, unchanged: false, words: { vocabulary: [...words.vocabulary], corrections } }
}
