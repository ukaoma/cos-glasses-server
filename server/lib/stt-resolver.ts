// Second-opinion resolver for meeting HQ (6.72.0). Algorithmic only: no model
// call, no network, no LLM. Transcription must never call `claude -p`.
//
// Two decoders hear the same window. Their words are aligned (edit distance
// over normalized words, constrained by timestamps when both sides carry
// them), and every place they disagree is recorded. The resolver then applies
// two measured rules, and nothing else:
//
//   1. Gap fill. Large-v3 is deletion-prone on G2 audio (silver deletions 6.1%
//      vs 2.1% for Parakeet Ultra), so where the primary is a Whisper engine and
//      the second opinion heard words the primary has nothing for, those words
//      are taken.
//   2. Vocabulary rescue. Where the second opinion's side of a disagreement
//      holds a profile vocabulary term the primary's side does not, the second
//      opinion's words are taken. Whisper sees the vocabulary prompt; Parakeet
//      does not, so this mostly helps a Parakeet primary.
//
// Substitutions are otherwise left alone. A region whose two sides differ in a
// negation, a number or a unit is never changed (the 2026-10-13 diagnostic saw
// "born lacking" become "born having" and "18 months" become "18 minutes"); it
// is kept as the primary heard it and listed as a protected disagreement.

export interface HypWord {
  word: string
  start: number
  end: number
  probability?: number
}

export interface Hypothesis {
  engine: string
  text: string
  /** Spoken words (not sub-word tokens), seconds from the start of the window. */
  words?: HypWord[]
}

export type DisagreementKind = 'substitution' | 'primary_only' | 'second_only'
export type ResolutionReason = 'gap_fill' | 'vocabulary' | 'protected' | null

export interface Disagreement {
  kind: DisagreementKind
  primary: string
  second: string
  start: number | null
  end: number | null
  taken: 'primary' | 'second'
  reason: ResolutionReason
}

export interface ResolveOptions {
  vocabulary: readonly string[]
  /** Gap fill only for a deletion-prone primary (the Whisper engines). */
  primaryDeletionProne: boolean
  /** false: report disagreements, change nothing. */
  apply: boolean
  /** Two words more than this far apart in time never align. */
  maxSkewSec?: number
}

export interface ResolveResult {
  text: string
  words: HypWord[]
  /** True when the resolver's words carry clocks for every word. */
  timed: boolean
  disagreements: Disagreement[]
  wordsFromSecond: number
  applied: boolean
  skipped?: 'too_long'
}

export const RESOLVER_VERSION = 'stt-resolver-v1'
/** Alignment is quadratic; a 30 s window is about 100 words a side. */
export const MAX_ALIGNMENT_CELLS = 2_000_000
export const DEFAULT_MAX_SKEW_SEC = 2
/** Agreed words each side of a region that a vocabulary match may span. */
export const CONTEXT_WORDS = 3

const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'nor', 'nothing', 'nobody', 'neither', 'without', 'cannot',
  'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'wont', 'wouldnt', 'cant',
  'couldnt', 'shouldnt', 'havent', 'hasnt', 'hadnt', 'aint', 'lacking', 'lack', 'lacks',
])
// Unambiguous units and number words only. "am", "one", "second" and "first"
// are everyday words far more often than quantities, and protecting them would
// block most real gap fills.
const UNITS = new Set([
  'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks',
  'month', 'months', 'year', 'years', 'percent', 'dollar', 'dollars', 'cents',
  'thousand', 'million', 'billion',
])
const NUMBER_WORDS = new Set([
  'zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'half', 'quarter', 'twice',
])
/** A gap fill this short lands inside a sentence the primary already heard, so
 *  a negation or number in it could flip that sentence. Longer runs are speech
 *  the primary dropped entirely. */
export const SHORT_INSERTION_WORDS = 3

/** Lowercase letters and digits only. "Don't," and "dont" are the same word. */
export function wordKey(word: string): string {
  return word.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function isProtectedKey(key: string): boolean {
  return NEGATIONS.has(key) || UNITS.has(key) || NUMBER_WORDS.has(key) || /\d/.test(key)
}

interface Token { display: string; key: string; start: number | null; end: number | null; probability?: number }

function tokens(h: Hypothesis): Token[] {
  const timedWords = Array.isArray(h.words) && h.words.length > 0 ? h.words : null
  const source = timedWords
    ? timedWords.map(w => ({
        display: String(w.word ?? '').trim(),
        start: Number.isFinite(w.start) ? w.start : null,
        end: Number.isFinite(w.end) ? w.end : null,
        probability: w.probability,
      }))
    : String(h.text ?? '').split(/\s+/).map(display => ({ display, start: null, end: null, probability: undefined }))
  return source
    .filter(t => t.display.length > 0)
    .map(t => ({ ...t, key: wordKey(t.display) }))
    .filter(t => t.key.length > 0)
}

function vocabSequences(vocabulary: readonly string[]): string[][] {
  const out: string[][] = []
  const seen = new Set<string>()
  for (const term of vocabulary) {
    const seq = String(term).split(/\s+/).map(wordKey).filter(Boolean)
    if (!seq.length) continue
    const id = seq.join(' ')
    if (seen.has(id)) continue
    seen.add(id)
    out.push(seq)
    // "ThriftCart" is also heard as "thrift cart": both spellings count.
    const joined = seq.join('')
    if (seq.length > 1 && !seen.has(joined)) { seen.add(joined); out.push([joined]) }
  }
  return out
}

function termsIn(keys: string[], sequences: string[][]): Set<string> {
  const found = new Set<string>()
  for (const seq of sequences) {
    for (let i = 0; i + seq.length <= keys.length; i++) {
      let hit = true
      for (let k = 0; k < seq.length; k++) if (keys[i + k] !== seq[k]) { hit = false; break }
      if (hit) { found.add(seq.join('')); break }
    }
  }
  return found
}

function mid(t: Token): number | null {
  if (t.start === null) return null
  return t.end === null ? t.start : (t.start + t.end) / 2
}

type Op = { kind: '=' | 's' | 'p' | 'q'; i: number | null; j: number | null }

/** Edit-distance alignment. Two words far apart in time cannot pair. */
function align(a: Token[], b: Token[], maxSkew: number): Op[] {
  const n = a.length, m = b.length
  const INF = 1e9
  const D = new Float64Array((n + 1) * (m + 1))
  const W = m + 1
  for (let i = 0; i <= n; i++) D[i * W] = i
  for (let j = 0; j <= m; j++) D[j] = j
  const pairCost = (i: number, j: number): number => {
    const ta = a[i], tb = b[j]
    const ma = mid(ta), mb = mid(tb)
    if (ma !== null && mb !== null && Math.abs(ma - mb) > maxSkew) return INF
    return ta.key === tb.key ? 0 : 1
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = D[(i - 1) * W + j - 1] + pairCost(i - 1, j - 1)
      const up = D[(i - 1) * W + j] + 1
      const left = D[i * W + j - 1] + 1
      D[i * W + j] = Math.min(diag, up, left)
    }
  }
  const ops: Op[] = []
  let i = n, j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const c = pairCost(i - 1, j - 1)
      if (c < INF && D[i * W + j] === D[(i - 1) * W + j - 1] + c) {
        ops.push({ kind: c === 0 ? '=' : 's', i: i - 1, j: j - 1 }); i--; j--; continue
      }
    }
    if (i > 0 && D[i * W + j] === D[(i - 1) * W + j] + 1) { ops.push({ kind: 'p', i: i - 1, j: null }); i--; continue }
    ops.push({ kind: 'q', i: null, j: j - 1 }); j--
  }
  return ops.reverse()
}

function span(ts: Token[]): { start: number | null; end: number | null } {
  const starts = ts.map(t => t.start).filter((x): x is number => x !== null)
  const ends = ts.map(t => t.end ?? t.start).filter((x): x is number => x !== null)
  return { start: starts.length ? Math.min(...starts) : null, end: ends.length ? Math.max(...ends) : null }
}

function sameProtected(p: Token[], q: Token[]): boolean {
  const pk = p.map(t => t.key).filter(isProtectedKey).join(' ')
  const qk = q.map(t => t.key).filter(isProtectedKey).join(' ')
  return pk === qk
}

export function resolveHypotheses(primary: Hypothesis, second: Hypothesis, options: ResolveOptions): ResolveResult {
  const P = tokens(primary), Q = tokens(second)
  const toWords = (ts: Token[]): HypWord[] => ts.map(t => ({
    word: t.display,
    start: t.start ?? 0,
    end: Math.max(t.start ?? 0, t.end ?? t.start ?? 0),
    ...(t.probability !== undefined ? { probability: t.probability } : {}),
  }))
  const primaryOnly = (): ResolveResult => ({
    text: P.map(t => t.display).join(' '),
    words: toWords(P),
    timed: P.length > 0 && P.every(t => t.start !== null),
    disagreements: [],
    wordsFromSecond: 0,
    applied: false,
  })
  if ((P.length + 1) * (Q.length + 1) > MAX_ALIGNMENT_CELLS) return { ...primaryOnly(), skipped: 'too_long' }

  const sequences = vocabSequences(options.vocabulary)
  const ops = align(P, Q, options.maxSkewSec ?? DEFAULT_MAX_SKEW_SEC)
  const out: Token[] = []
  const disagreements: Disagreement[] = []
  let wordsFromSecond = 0
  let k = 0
  while (k < ops.length) {
    if (ops[k].kind === '=') { out.push(P[ops[k].i!]); k++; continue }
    const p: Token[] = [], q: Token[] = []
    const regionStart = k
    while (k < ops.length && ops[k].kind !== '=') {
      if (ops[k].i !== null) p.push(P[ops[k].i!])
      if (ops[k].j !== null) q.push(Q[ops[k].j!])
      k++
    }
    // Agreed words on both sides, so a term split across the edge of the
    // region ("drift cart" vs "thrift cart") is still seen whole.
    const before: string[] = [], after: string[] = []
    for (let b = regionStart - 1; b >= 0 && before.length < CONTEXT_WORDS && ops[b].kind === '='; b--) before.unshift(P[ops[b].i!].key)
    for (let a = k; a < ops.length && after.length < CONTEXT_WORDS && ops[a].kind === '='; a++) after.push(P[ops[a].i!].key)
    const kind: DisagreementKind = !p.length ? 'second_only' : !q.length ? 'primary_only' : 'substitution'
    let take: 'primary' | 'second' = 'primary'
    let reason: ResolutionReason = null
    if (q.length) {
      const withContext = (side: Token[]) => [...before, ...side.map(t => t.key), ...after]
      const primaryTerms = termsIn(withContext(p), sequences)
      const newTerms = [...termsIn(withContext(q), sequences)].filter(t => !primaryTerms.has(t))
      const wantGap = kind === 'second_only' && options.primaryDeletionProne
      const wantVocab = newTerms.length > 0
      if (wantGap || wantVocab) {
        const mayFlip = kind !== 'second_only' || q.length <= SHORT_INSERTION_WORDS
        if (mayFlip && !sameProtected(p, q)) reason = 'protected'
        else { take = 'second'; reason = wantVocab ? 'vocabulary' : 'gap_fill' }
      }
    }
    const where = span([...p, ...q])
    disagreements.push({
      kind,
      primary: p.map(t => t.display).join(' '),
      second: q.map(t => t.display).join(' '),
      start: where.start,
      end: where.end,
      taken: options.apply ? take : 'primary',
      reason,
    })
    if (options.apply && take === 'second') { out.push(...q); wordsFromSecond += q.length }
    else out.push(...p)
  }
  return {
    text: out.map(t => t.display).join(' '),
    words: toWords(out),
    timed: out.length > 0 && out.every(t => t.start !== null),
    disagreements,
    wordsFromSecond,
    applied: options.apply,
  }
}

/** Whisper's deletion-prone profile is the reason gap fill exists. */
export function isDeletionProneEngine(engine: string): boolean {
  return engine === 'large-v3' || engine === 'large-v3-legacy'
}
