// Transcript cleanup (6.77.0): which passages are doubtful, decided with no model.
//
// Two steps, both deterministic.
//
// 1. FIXES. fuzzy-correct's own rule (fuzzyReplacementFor) over CAPITALISED words that are
//    not already a known spelling: this meeting's screen and file terms (a temporary
//    per-meeting vocabulary) at any confidence; the curated dictionary and the owner only
//    for a word the engine was unsure of. Never a lowercase word, never anyone but the owner as
//    a target (that is the model's call), never into an inflection ("Setting" is never a
//    "Settings" button label). Why each rule exists is measured in deterministicFixes. Fixes
//    are free and are applied before any model call, so the obvious cases never cost a token.
//
// 2. SPANS. What is left that the engine or the names say is unsure:
//    low_confidence   the decoder's own per-word probability below its engine's floor
//                     (Parakeet 0.50, the resolver's floor; Whisper 0.40)
//    near_name        a word the engine was unsure of (below 0.9) that is a capitalised word
//                     one edit past fuzzy-correct's limit from a known name, or that sounds
//                     like one (same consonant skeleton and onset); two or three short
//                     adjacent pieces joined ("U coma"), none a function word; or the
//                     leading-y rule at any confidence ("Yukoma" for Ukaoma)
//    oov_capitalized  a capitalised word mid-sentence that is no known name and no common
//                     word, within two words of a known name ("Grace Eucoma")
//    repeat           a phrase of 2 to 4 words (or one long word) said three or more
//                     times in a row: the classic decoder loop
//    Flagged words one word apart merge; a span holds at most 6 words (12 for a repeat)
//    and never crosses a speaker turn or a clause (a comma or a sentence end). Spans are ranked (names first, then repeats, then
//    the least confident) and cut to the per-meeting cap.

import { canonicalFuzzyTargets, fuzzyReplacementFor, isCommonEnglishWord, levenshtein } from './fuzzy-correct.js'
import { closeSpelling, fold, maxFuzzyDistance, soundsAlike, type Token, type TranscriptLine } from './transcript-cleanup-text.js'
import type { NameTarget } from './transcript-cleanup-context.js'

export type SpanReason = 'low_confidence' | 'near_name' | 'oov_capitalized' | 'repeat'

export interface Fix {
  line: number
  start: number
  end: number
  original: string
  replacement: string
  /** The target came only from this meeting's screen or files. */
  fromMeeting: boolean
  token: number
}

export interface CleanupSpan {
  id: string
  line: number
  start: number
  end: number
  text: string
  before: string
  after: string
  reasons: SpanReason[]
  /** Token range [from, to) in the flat token list. */
  from: number
  to: number
  minProbability?: number
  atMs?: number
  /** Known names this span is near, for the prompt and the notes search. */
  near: string[]
}

export const SPAN_LIMITS = {
  maxSpanWords: 6,
  maxRepeatWords: 12,
  contextWords: 12,
  defaultMaxSpans: 40,
  hardMaxSpans: 80,
} as const

export const LOW_CONFIDENCE: Record<string, number> = { parakeet: 0.5, whisper: 0.4, default: 0.45 }
export function lowConfidenceFloor(engine: string | undefined): number {
  if (!engine) return LOW_CONFIDENCE.default
  if (engine.startsWith('parakeet')) return LOW_CONFIDENCE.parakeet
  if (engine.startsWith('large-v3') || engine.includes('whisper') || engine.startsWith('turbo')) return LOW_CONFIDENCE.whisper
  return LOW_CONFIDENCE.default
}

const FILLERS = new Set(['um', 'uh', 'umm', 'uhm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm', 'oh', 'huh'])

const INFLECTION = /^(?:s|es|ed|d|ing|er|ers|ly)$/
/** "Setting" and "Settings", "Record" and "Recording": one word's inflection of the other. */
export function inflectionOf(a: string, b: string): boolean {
  const x = fold(a), y = fold(b)
  if (x === y) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return long.startsWith(short) && INFLECTION.test(long.slice(short.length))
}

const POSSESSIVE = /(['’]s)$/i

/**
 * Deterministic fixes over the tokens. Mutates nothing; the caller applies them.
 *
 * Conservative by measurement (2026-10-17, read-only, 68 real meetings, 38.5 hours):
 *   - fuzzy-correct's rule over LOWERCASE words, with 94 enrolled names and the vocabulary
 *     as targets, rewrote everyday words into names (giant, permit, companies, weight,
 *     pitch, range) 29 times in two meetings. Only a capitalised word is rewritten here.
 *   - over capitalised words with every enrolled name as a target it still swapped one real
 *     name for another (Kelsey to Kelley, Erica to Eric, Sandy to Andy) and a product for a
 *     surname (Slack to Black, 14 times). So a word that is itself a known spelling is never
 *     rewritten, people's names other than the owner's are NOT targets here (enrolled or attending: with the
 *     attendees as targets Slack still became Black twice; they reach the model as context
 *     and drive near-name spans instead), and the curated dictionary and the owner
 *     ("strong" targets) rewrite only a word the engine was unsure of. With those rules the
 *     68 meetings got 27 fixes, all real (Manuj to Manoj 9 times, MarketPOS to MarktPOS).
 *   - a term from THIS meeting's screen or files (the per-meeting vocabulary) may rewrite a
 *     capitalised word at any confidence: it is what was on screen while it was said.
 * Never into an inflection of the word, and a word that only opens a sentence only when the
 * engine was unsure of it.
 */
export function deterministicFixes(
  tokens: readonly Token[],
  strongTargets: string[],
  meetingTargets: readonly NameTarget[],
  known: ReadonlySet<string> = new Set(),
): Fix[] {
  const strong = canonicalFuzzyTargets(strongTargets)
  const meeting = canonicalFuzzyTargets(meetingTargets.filter(t => t.fromMeeting).map(t => t.display))
  const allLower = new Set([...strong, ...meeting].map(t => t.toLowerCase()))
  const fixes: Fix[] = []
  for (const token of tokens) {
    const possessive = POSSESSIVE.exec(token.core)?.[1] ?? ''
    const base = possessive ? token.core.slice(0, -possessive.length) : token.core
    if (!/^\p{Lu}/u.test(base) || allLower.has(base.toLowerCase()) || known.has(fold(base))) continue
    const unsure = token.probability === undefined || token.probability < NEAR_NAME_UNSURE
    if (token.sentenceStart && !unsure) continue
    let replacement = unsure ? fuzzyReplacementFor(base, strong, allLower) : null
    let fromMeeting = false
    if (replacement === null && meeting.length) {
      replacement = fuzzyReplacementFor(base, meeting, allLower)
      fromMeeting = replacement !== null
    }
    if (replacement === null || replacement === base || inflectionOf(base, replacement)) continue
    fixes.push({ line: token.line, start: token.start, end: token.end, original: token.core, replacement: replacement + possessive, fromMeeting, token: token.i })
  }
  return fixes
}

interface Flag { reasons: Set<SpanReason>; near: Set<string> }

/**
 * Below this the engine was not sure enough of a word for "it is near a name" to count.
 * Measured 2026-10-17 on four real Parakeet meetings (read-only, no model): with no
 * confidence gate the edit-distance rule flagged everyday words ("lives" for Miles,
 * "rates" for Nate) about eight times a minute.
 */
export const NEAR_NAME_UNSURE = 0.9

/** Short, frequent words that are never a fragment of a split name ("like i" is not "Mike"). */
const FUNCTION_WORDS = new Set(`a an the and or but if so of to in on at by for from with as is am are was were be been it its i me my we us our you
your he him his she her they them their this that these those there here what who how why when where not no yes yeah yep ok okay oh uh um
mm hmm ah like just do did does done can could would should will shall may might must have has had get got go going went say said says
see saw know knew think thought want one two three four five six seven eight nine ten all any some more most very too also then than
now well still even ever only own same out up down off over into onto about after before again once s t d ll re ve m o y`.split(/\s+/).filter(Boolean))

interface NearInput { key: string; capitalized: boolean; probability?: number; join: boolean }

/**
 * The known name `key` is plausibly a mishearing of, or null.
 *   - the leading-y rule (meeting-ask-owner.ts): "Yukoma" is one edit from "Ukaoma" once its y goes
 *   - otherwise only for a word the engine was unsure of (below NEAR_NAME_UNSURE, or unscored):
 *       a capitalised single word one edit past fuzzy-correct's own limit, or
 *       any word (or short joined pieces) that sounds like the name (soundsAlike)
 *   - joined pieces may also be within fuzzy-correct's own limit ("U coma" read as one word)
 */
function nearName(input: NearInput, targets: readonly NameTarget[], known: ReadonlySet<string>): string | null {
  const { key } = input
  if (key.length < 5) return null
  if (!input.join && (known.has(key) || isCommonEnglishWord(key))) return null
  const unsure = input.probability === undefined || input.probability < NEAR_NAME_UNSURE
  let best: { d: number; display: string } | null = null
  for (const t of targets) {
    if (Math.abs(t.key.length - key.length) > 2) continue
    const d = levenshtein(key, t.key)
    // A single word spelled exactly like a name is the name. Pieces that join into one exactly ("Uka oma") are the
    // strongest sign of a split name there is.
    if (d === 0 && !input.join) return null
    // "setting" next to a "Settings" label is the same word, not a misheard name.
    if (inflectionOf(key, t.key)) continue
    const md = maxFuzzyDistance(Math.max(key.length, t.key.length))
    const yRule = /^y[aeiou]/.test(key) && !/^y/.test(t.key) && levenshtein(key.slice(1), t.key) <= 1
    const hit = yRule || (unsure && (
      input.join ? (d <= md || soundsAlike(key, t.key)) : ((input.capitalized && d <= md + 1) || soundsAlike(key, t.key))))
    if (hit && (!best || d < best.d)) best = { d, display: t.display }
  }
  return best?.display ?? null
}

/** Repeated phrase runs: [from, to) token ranges. */
export function repeatRuns(tokens: readonly Token[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let i = 0
  while (i < tokens.length) {
    let found: [number, number] | null = null
    for (let unit = 4; unit >= 1 && !found; unit--) {
      const head = tokens.slice(i, i + unit)
      if (head.length < unit || head.some(t => t.line !== tokens[i].line || !t.key)) continue
      if (unit === 1 && head[0].key.length < 4) continue
      let reps = 1
      while (true) {
        const next = tokens.slice(i + reps * unit, i + (reps + 1) * unit)
        if (next.length < unit || next.some((t, k) => t.line !== tokens[i].line || t.key !== head[k].key)) break
        reps++
      }
      if (reps >= (unit === 1 ? 4 : 3)) found = [i, i + reps * unit]
    }
    if (found) { runs.push(found); i = found[1] } else i++
  }
  return runs
}

export interface SelectOptions {
  maxSpans?: number
  /** Tokens already fixed deterministically: never flagged again. */
  fixed?: ReadonlySet<number>
}

export interface SpanSelection {
  spans: CleanupSpan[]
  /** Before the per-meeting cap. */
  found: number
  byReason: Record<SpanReason, number>
}

function snippet(tokens: readonly Token[], from: number, to: number, line: number): string {
  return tokens.slice(Math.max(0, from), Math.max(0, to)).filter(t => t.line === line).map(t => t.raw).join(' ')
}

export function selectSpans(
  lines: readonly TranscriptLine[],
  tokens: readonly Token[],
  targets: readonly NameTarget[],
  known: ReadonlySet<string>,
  opts: SelectOptions = {},
): SpanSelection {
  const maxSpans = Math.max(0, Math.min(opts.maxSpans ?? SPAN_LIMITS.defaultMaxSpans, SPAN_LIMITS.hardMaxSpans))
  const fixed = opts.fixed ?? new Set<number>()
  const flags = new Map<number, Flag>()
  const flag = (i: number, reason: SpanReason, near?: string) => {
    const f = flags.get(i) ?? { reasons: new Set<SpanReason>(), near: new Set<string>() }
    f.reasons.add(reason)
    if (near) f.near.add(near)
    flags.set(i, f)
  }
  const nameKeys = new Set(targets.map(t => t.key))
  const nearMemo = new Map<string, string | null>()

  for (const t of tokens) {
    if (fixed.has(t.i) || !t.key) continue
    if (t.probability !== undefined && t.probability < lowConfidenceFloor(t.engine) && !FILLERS.has(t.key)) flag(t.i, 'low_confidence')
    if (!known.has(t.key)) {
      const memo = `${t.key}|${/^\p{Lu}/u.test(t.core) ? 1 : 0}|${t.probability === undefined || t.probability < NEAR_NAME_UNSURE ? 1 : 0}`
      let near = nearMemo.get(memo)
      if (near === undefined) {
        near = nearName({ key: t.key, capitalized: /^\p{Lu}/u.test(t.core), probability: t.probability, join: false }, targets, known)
        nearMemo.set(memo, near)
      }
      if (near) flag(t.i, 'near_name', near)
    }
  }
  // Two or three adjacent words joined: "U coma", "Yu ko ma". One of them must be short (a split fragment).
  for (let i = 0; i + 1 < tokens.length; i++) {
    for (const width of [2, 3]) {
      const group = tokens.slice(i, i + width)
      if (group.length < width || group.some(g => g.line !== tokens[i].line || !g.key || fixed.has(g.i) || known.has(g.key))) continue
      // A split name is short pieces ("U coma", "Yu ko ma"); a long word plus a short one is just two words,
      // and a function word is never a piece of a name.
      if (!group.some(g => g.key.length <= 3) || group.some(g => g.key.length > 5 || FUNCTION_WORDS.has(g.key))) continue
      const joined = group.map(g => g.key).join('')
      const scores = group.map(g => g.probability).filter((p): p is number => p !== undefined)
      const near = nearName({ key: joined, capitalized: group.some(g => /^\p{Lu}/u.test(g.core)), probability: scores.length === group.length ? Math.min(...scores) : undefined, join: true }, targets, known)
      if (near) for (const g of group) flag(g.i, 'near_name', near)
    }
  }
  for (const t of tokens) {
    if (fixed.has(t.i) || t.sentenceStart || !/^\p{Lu}/u.test(t.core) || t.key.length < 3) continue
    if (known.has(t.key) || isCommonEnglishWord(t.key) || /^\p{Lu}+$/u.test(t.core) || t.core === 'I' || /^I['’]/.test(t.core)) continue
    const neighbours = tokens.slice(Math.max(0, t.i - 2), t.i + 3).filter(n => n.i !== t.i && n.line === t.line)
    const anchor = neighbours.find(n => nameKeys.has(n.key) || (known.has(n.key) && /^\p{Lu}/u.test(n.core)))
    if (anchor) flag(t.i, 'oov_capitalized', targets.find(x => x.key === anchor.key)?.display ?? anchor.core)
  }

  // Group flagged tokens into spans inside one line.
  type Draft = { from: number; to: number; reasons: Set<SpanReason>; near: Set<string> }
  const drafts: Draft[] = []
  const repeatTokens = new Set<number>()
  for (const [from, to] of repeatRuns(tokens)) {
    if ([...Array(to - from).keys()].some(k => fixed.has(from + k))) continue
    const end = Math.min(to, from + SPAN_LIMITS.maxRepeatWords)
    drafts.push({ from, to: end, reasons: new Set<SpanReason>(['repeat']), near: new Set() })
    for (let k = from; k < end; k++) repeatTokens.add(k)
  }
  const flagged = [...flags.keys()].filter(i => !repeatTokens.has(i)).sort((a, b) => a - b)
  let k = 0
  while (k < flagged.length) {
    const from = flagged[k]
    let to = from + 1
    const reasons = new Set(flags.get(from)!.reasons)
    const near = new Set(flags.get(from)!.near)
    k++
    while (k < flagged.length) {
      const next = flagged[k]
      if (tokens[next].line !== tokens[from].line || next - to > 1 || next + 1 - from > SPAN_LIMITS.maxSpanWords) break
      // Never across a clause: "Yukoma and eucoma, then U coma" is two passages, not one.
      if (tokens.slice(to - 1, next).some(t => /[,.;:!?]["')\]]*$/.test(t.raw))) break
      if ([...Array(next - to).keys()].some(g => repeatTokens.has(to + g))) break
      for (const r of flags.get(next)!.reasons) reasons.add(r)
      for (const n of flags.get(next)!.near) near.add(n)
      to = next + 1
      k++
    }
    drafts.push({ from, to, reasons, near })
  }

  const byReason: Record<SpanReason, number> = { low_confidence: 0, near_name: 0, oov_capitalized: 0, repeat: 0 }
  for (const d of drafts) for (const r of d.reasons) byReason[r]++
  const minP = (d: Draft) => {
    const ps = tokens.slice(d.from, d.to).map(t => t.probability).filter((p): p is number => p !== undefined)
    return ps.length ? Math.min(...ps) : undefined
  }
  const score = (d: Draft) => (d.reasons.has('near_name') ? 4 : 0) + (d.reasons.has('oov_capitalized') ? 3 : 0)
    + (d.reasons.has('repeat') ? 2 : 0) + (d.reasons.has('low_confidence') ? 1 + (1 - (minP(d) ?? 1)) : 0)
  const kept = [...drafts].sort((a, b) => score(b) - score(a) || a.from - b.from).slice(0, maxSpans).sort((a, b) => a.from - b.from)

  const spans = kept.map((d, n): CleanupSpan => {
    const first = tokens[d.from], last = tokens[d.to - 1]
    const line = lines.find(l => l.index === first.line)!
    const p = minP(d)
    const at = tokens.slice(d.from, d.to).map(t => t.atMs).find(v => v !== undefined)
    return {
      id: `S${n + 1}`,
      line: first.line,
      start: first.start,
      end: last.end,
      text: line.text.slice(first.start, last.end),
      before: snippet(tokens, d.from - SPAN_LIMITS.contextWords, d.from, first.line),
      after: snippet(tokens, d.to, d.to + SPAN_LIMITS.contextWords, first.line),
      reasons: [...d.reasons].sort(),
      from: d.from,
      to: d.to,
      ...(p !== undefined ? { minProbability: Math.round(p * 1000) / 1000 } : {}),
      ...(at !== undefined ? { atMs: at } : {}),
      near: [...d.near].slice(0, 3),
    }
  })
  return { spans, found: drafts.length, byReason }
}

/** For edit validation: is `word` plausibly one of the span's own words, misheard? */
export function resemblesSpan(word: string, spanWords: readonly string[]): boolean {
  const w = fold(word)
  if (!w) return true
  const keys = spanWords.map(fold).filter(Boolean)
  const joined = keys.join('')
  return keys.some(k => k === w || closeSpelling(k, w) || soundsAlike(k, w)) || closeSpelling(joined, w) || soundsAlike(joined, w)
}
