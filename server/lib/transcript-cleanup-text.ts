// Transcript cleanup (6.77.0): the text model every other cleanup module shares.
//
// A saved meeting's `## Transcript` section is lines of `[Label]: words`. Cleanup only
// ever edits the WORDS of a line, never its label, never a line it cannot parse, and
// never across a line break: a speaker turn is the largest unit an edit can touch.
//
// Tokens are whitespace runs inside a line's text. Each carries its `core`: the token
// without leading and trailing punctuation, which is what is compared, flagged and
// replaced, so "Ukoma," becomes "Ukaoma," and the comma stays exactly where it was.
//
// No IO and no model here.

import { levenshtein } from './fuzzy-correct.js'

export interface TranscriptLine {
  index: number
  /** `[Label]: ` including the trailing space, or '' for a line without a label. */
  prefix: string
  label: string | null
  text: string
  /** False for blank lines and anything that is not a speaker turn. Never edited. */
  editable: boolean
}

export interface Token {
  /** Position in the flat token list. */
  i: number
  line: number
  /** Offsets of the core inside `line.text`. */
  start: number
  end: number
  raw: string
  core: string
  key: string
  /** First token of its line, or after a sentence end. */
  sentenceStart: boolean
  probability?: number
  /** Epoch ms of the word, when the batch words could be aligned. */
  atMs?: number
  engine?: string
}

const LINE = /^\[([^\]\n]{1,80})\]: ?(.*)$/

export function parseTranscriptLines(section: string): TranscriptLine[] {
  return section.split('\n').map((raw, index) => {
    const m = LINE.exec(raw)
    if (!m) return { index, prefix: '', label: null, text: raw, editable: false }
    const prefix = raw.slice(0, raw.length - m[2].length)
    return { index, prefix, label: m[1], text: m[2], editable: m[2].trim().length > 0 }
  })
}

export function joinTranscriptLines(lines: readonly TranscriptLine[]): string {
  return lines.map(line => line.prefix + line.text).join('\n')
}

/** Letters and digits only, accents folded, lowercase. The comparison form of a word. */
export function fold(word: string): string {
  return word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

export function tokenize(lines: readonly TranscriptLine[]): Token[] {
  const out: Token[] = []
  for (const line of lines) {
    if (!line.editable) continue
    let sentenceStart = true
    for (const m of line.text.matchAll(/\S+/g)) {
      const raw = m[0]
      const at = m.index ?? 0
      const lead = /^[^\p{L}\p{N}]*/u.exec(raw)![0].length
      const core = raw.replace(EDGE, '')
      const start = at + lead
      out.push({ i: out.length, line: line.index, start, end: start + core.length, raw, core, key: fold(core), sentenceStart })
      sentenceStart = /[.!?]["')\]]*$/.test(raw)
    }
  }
  return out
}

/** One spoken word from the batch decode, placed on the meeting clock. */
export interface WordInfo {
  word: string
  probability?: number
  atMs?: number
  engine?: string
}

/**
 * The batch words of a saved meeting, in transcript order, from its `.g2-chunks.json`
 * sidecar. A segment's word times are seconds from that window's start; the window
 * starts at `startElapsed` on the meeting clock (the same convention
 * mapWordsToSpeakers uses), and the meeting started at `startTime` (epoch ms).
 */
export function wordInfoFromSidecar(sidecar: Record<string, unknown>): WordInfo[] {
  const segments = Array.isArray(sidecar.batchSegments) ? sidecar.batchSegments : []
  const startTime = typeof sidecar.startTime === 'number' && Number.isFinite(sidecar.startTime) ? sidecar.startTime : null
  const out: WordInfo[] = []
  for (const raw of segments) {
    if (!raw || typeof raw !== 'object') continue
    const segment = raw as { words?: unknown; startElapsed?: unknown; stt?: { engine?: unknown } }
    const words = Array.isArray(segment.words) ? segment.words : []
    const startElapsed = typeof segment.startElapsed === 'number' && Number.isFinite(segment.startElapsed) ? segment.startElapsed : null
    const engine = typeof segment.stt?.engine === 'string' ? segment.stt.engine : undefined
    for (const w of words) {
      if (!w || typeof w !== 'object') continue
      const word = typeof (w as { word?: unknown }).word === 'string' ? (w as { word: string }).word.trim() : ''
      if (!word) continue
      const p = (w as { probability?: unknown }).probability
      const s = (w as { start?: unknown }).start
      const atMs = startTime !== null && startElapsed !== null && typeof s === 'number' && Number.isFinite(s)
        ? Math.round(startTime + startElapsed + s * 1000) : undefined
      out.push({
        word,
        ...(typeof p === 'number' && Number.isFinite(p) ? { probability: p } : {}),
        ...(atMs !== undefined ? { atMs } : {}),
        ...(engine ? { engine } : {}),
      })
    }
  }
  return out
}

/** How far ahead the aligner looks for a transcript token among the batch words. */
export const ALIGN_LOOKAHEAD = 40

/**
 * Attach probability, time and engine to the tokens the batch words produced.
 *
 * The saved transcript IS those words (selectBatchTranscriptForPersistence joins
 * them; the hallucination line filter may drop a line; Nemotron only relabels), so
 * a greedy forward match finds them in order. A token with no match within the
 * lookahead stays unaligned: it simply carries no confidence, which can only make
 * cleanup look at it less, never more.
 */
export function alignWordInfo(tokens: Token[], words: readonly WordInfo[]): number {
  let j = 0
  let aligned = 0
  for (const token of tokens) {
    const limit = Math.min(words.length, j + ALIGN_LOOKAHEAD)
    let hit = -1
    for (let k = j; k < limit; k++) {
      if (words[k].word === token.raw || fold(words[k].word) === token.key) { hit = k; break }
    }
    if (hit < 0) continue
    const w = words[hit]
    if (w.probability !== undefined) token.probability = w.probability
    if (w.atMs !== undefined) token.atMs = w.atMs
    if (w.engine) token.engine = w.engine
    aligned++
    j = hit + 1
  }
  return aligned
}

/**
 * A consonant skeleton: how a word sounds with its vowels unsure. Ukaoma, Yukoma,
 * eucoma and "U coma" all read "km". Only ever used together with an onset check and
 * a length bound, because a two-letter skeleton alone matches far too much.
 */
export function skeleton(word: string): string {
  let s = fold(word).replace(/[0-9]/g, '')
  s = s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k')
    .replace(/x/g, 'ks').replace(/z/g, 's').replace(/dg/g, 'j')
  s = s.replace(/[aeiouy]/g, '')
  return s.replace(/(.)\1+/g, '$1')
}

/** Vowel onset, counting a leading y before a vowel ("Yukoma") as a vowel. */
export function vowelOnset(word: string): boolean {
  const f = fold(word)
  return /^[aeiou]/.test(f) || /^y[aeiou]/.test(f)
}

export function maxFuzzyDistance(length: number): number {
  return length <= 8 ? 1 : length <= 11 ? 2 : 3
}

/** True when two folded words sound alike under the skeleton rule. */
export function soundsAlike(a: string, b: string): boolean {
  const fa = fold(a), fb = fold(b)
  if (!fa || !fb || Math.abs(fa.length - fb.length) > 2) return false
  const sa = skeleton(fa), sb = skeleton(fb)
  if (sa.length < 2 || sa !== sb) return false
  if (vowelOnset(fa) !== vowelOnset(fb)) return false
  const d = levenshtein(fa, fb)
  return d <= Math.max(maxFuzzyDistance(Math.max(fa.length, fb.length)) + 2, Math.ceil(Math.max(fa.length, fb.length) * 0.5))
}

/** Edit distance small enough that two words are plausibly one word misheard. */
export function closeSpelling(a: string, b: string): boolean {
  const fa = fold(a), fb = fold(b)
  if (!fa || !fb) return false
  if (fa === fb) return true
  const longest = Math.max(fa.length, fb.length)
  return levenshtein(fa, fb) <= Math.max(1, Math.floor(longest / 3))
}

