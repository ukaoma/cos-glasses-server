/**
 * 6.91.0: the meaning guard (plan r2). Deterministic, after the polish model, beside the link
 * guard (dictation-format.ts polishLinkProblem), on the `message` and `prompt_draft` buckets only.
 *
 * Its input is `cleaned`, the text the model was given (after the dictionary, fuzzy and filler
 * passes), never the raw heard text, the same input the link guard uses. It compares SETS of
 * guarded tokens, in four kinds:
 * - negation: not / n't / cannot (one NEG token), never, no, none, nothing, nobody, neither, nor,
 *   without, unless, except;
 * - number: digits, number words, ordinals, %, $, k and thousand, clock times and am/pm;
 * - date: a weekday or a month;
 * - name: a mid-sentence capital, a dictionary term or a speaker name. A sentence-initial word and
 *   "I" are not names unless they are dictionary terms. Skipped for a dictation that is not English.
 *
 * Normalization: case-insensitive; split on - / @ . and every other mark; number words become
 * digits ("twenty twenty six" may come back as "2026"); possessives and plurals fold; a name
 * re-spelled to a dictionary term (or to a near form the model was asked to fix) counts as kept.
 *
 * It trips on a DROPPED token of any kind, and on an ADDED negation or number. A dropped token is
 * exempt only when a correction marker follows it and a token of the SAME kind replaces it within
 * a few words ("five, actually six"; "Priya ... actually Dana"; "Tuesday, no wait, Wednesday").
 * A negation is never exempt; only a marker phrase's own words ("no wait", "wait no", ", no,",
 * "never mind") are not negations. Known gaps, stated and not claimed: reordering, and
 * before/after/only. Pure; it never throws on strings and logs nothing.
 */
export type MeaningGuardKind = 'negation' | 'number' | 'date' | 'name'
export const MEANING_GUARD_KINDS: readonly MeaningGuardKind[] = ['negation', 'number', 'date', 'name']

export interface MeaningGuardProblem {
  kind: MeaningGuardKind
  dropped: Record<MeaningGuardKind, number>
  added: Record<MeaningGuardKind, number>
  /** True when the name check was skipped because the dictation is not English. */
  namesSkipped: boolean
}

export function meaningGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.COS_DICTATION_MEANING_GUARD ?? '').trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off')
}

interface Tok { raw: string; low: string; sentenceStart: boolean; pause: boolean }
interface Item { kind: MeaningGuardKind; key: string; pos: number }

const ONES = new Map(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((w, i) => [w, i]))
const TENS = new Map([['twenty', 20], ['thirty', 30], ['forty', 40], ['fourty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90]])
const SCALES = new Map([['hundred', 100], ['thousand', 1_000], ['k', 1_000], ['million', 1_000_000], ['billion', 1_000_000_000]])
const ORDINALS = new Map([['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5], ['sixth', 6], ['seventh', 7], ['eighth', 8],
  ['ninth', 9], ['tenth', 10], ['eleventh', 11], ['twelfth', 12], ['twentieth', 20], ['thirtieth', 30]])
/** Unit and time words that are part of a number item. */
const NUMBER_WORDS = new Map([['percent', 'percent'], ['percentage', 'percent'], ['dollar', 'dollar'], ['dollars', 'dollar'], ['buck', 'dollar'],
  ['bucks', 'dollar'], ['euro', 'euro'], ['euros', 'euro'], ['pound', 'pound'], ['pounds', 'pound'], ['cent', 'cent'], ['cents', 'cent'],
  ['noon', 'noon'], ['midnight', 'midnight']])
const SYMBOLS = new Map([['%', 'percent'], ['$', 'dollar'], ['€', 'euro'], ['£', 'pound'], ['¢', 'cent']])

const NEG_WORDS = new Set(['never', 'no', 'none', 'nothing', 'nobody', 'neither', 'nor', 'without', 'unless', 'except'])

const WEEKDAYS = new Map([['monday', 'monday'], ['tuesday', 'tuesday'], ['wednesday', 'wednesday'], ['thursday', 'thursday'], ['friday', 'friday'],
  ['saturday', 'saturday'], ['sunday', 'sunday'], ['mon', 'monday'], ['tue', 'tuesday'], ['tues', 'tuesday'], ['wed', 'wednesday'],
  ['thu', 'thursday'], ['thur', 'thursday'], ['thurs', 'thursday'], ['fri', 'friday'], ['sat', 'saturday'], ['sun', 'sunday']])
const MONTHS = new Map([['january', 'january'], ['february', 'february'], ['march', 'march'], ['april', 'april'], ['may', 'may'], ['june', 'june'],
  ['july', 'july'], ['august', 'august'], ['september', 'september'], ['october', 'october'], ['november', 'november'], ['december', 'december'],
  ['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'], ['jun', 'june'], ['jul', 'july'], ['aug', 'august'],
  ['sep', 'september'], ['sept', 'september'], ['oct', 'october'], ['nov', 'november'], ['dec', 'december']])
/** Words that are dates only when capitalized: "may" is a verb, "march" a verb, "sun" and "wed" words. */
const DATE_NEEDS_CAPITAL = new Set(['may', 'march', 'mar', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'])

const NOT_NAMES = new Set(['i', "i'm", "i'll", "i've", "i'd", 'ok', 'okay', 'oh', 'o', 'a', 'am', 'pm'])

/** Correction markers, as token sequences (", no," is "no" between pause marks, checked below). */
const MARKERS: string[][] = [['actually'], ['i', 'mean'], ['i', 'meant'], ['no', 'wait'], ['wait', 'no'], ['wait'], ['sorry'],
  ['or', 'rather'], ['make', 'that'], ['scratch', 'that'], ['never', 'mind'], ['nevermind'], ['correction']]
/** Marker phrases whose words are not negations, on either side. */
const NEG_MARKER_PHRASES: string[][] = [['no', 'wait'], ['wait', 'no'], ['never', 'mind'], ['nevermind']]
const DROP_TO_MARKER = 8
const MARKER_TO_REPLACEMENT = 6

const ENGLISH = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'it', 'this',
  'that', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'our', 'your', 'their', 'can', 'will', 'do', 'does', 'not', 'at', 'from', 'have', 'has',
  'me', 'us', 'so', 'if', 'what', 'just', 'about', 'there', 'here', 'all', 'some', 'any', 'how', 'why', 'when', 'need', 'want', 'get', 'make'])

function normalize(text: string): string {
  return text
    .replace(/[’‘ʼ]/g, "'")
    .replace(/\b([ap])\.\s?m\b\.?/gi, '$1m')
    .replace(/(\d)\s?(am|pm)\b/gi, '$1 $2')
    // "three o'clock" and "3:00" are one time.
    .replace(/\s?o'?clock\b/gi, ':00')
    // A thousands separator is not a split: "1,000" is 1000.
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d)k\b/gi, '$1 k')
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = []
  const re = /[\p{L}\p{N}]+(?:'[\p{L}]+)*|[%$€£¢]/gu
  let m: RegExpExecArray | null
  let last = 0
  while ((m = re.exec(text))) {
    const gap = text.slice(last, m.index)
    const before = text.slice(0, m.index).replace(/[\s"'“”()[\]{}*_-]+$/u, '')
    const sentenceStart = before.length === 0 || /[.!?:\n•]$/.test(before) || /\n\s*(?:[-*•]|\d+[.)])?\s*$/.test(text.slice(0, m.index))
    out.push({ raw: m[0], low: m[0].toLowerCase(), sentenceStart, pause: /[,;.!?—–()]/.test(gap) })
    last = m.index + m[0].length
  }
  return out
}

const fold = (w: string) => {
  let x = w.replace(/'s$/, '')
  if (x.length > 3 && /[^s]s$/.test(x)) x = x.slice(0, -1)
  return x
}

function startsWith(tokens: Tok[], at: number, phrase: string[]): boolean {
  return phrase.every((w, i) => tokens[at + i]?.low === w)
}

/** Positions covered by a marker phrase, and where each marker ends. */
function markers(tokens: Tok[]): { cover: Set<number>; negCover: Set<number>; spans: Array<[number, number]> } {
  const cover = new Set<number>()
  const negCover = new Set<number>()
  const spans: Array<[number, number]> = []
  for (let i = 0; i < tokens.length; i++) {
    const phrase = MARKERS.find(p => startsWith(tokens, i, p))
    if (phrase) {
      spans.push([i, i + phrase.length - 1])
      for (let k = 0; k < phrase.length; k++) cover.add(i + k)
      if (NEG_MARKER_PHRASES.some(p => p.length === phrase.length && startsWith(tokens, i, p))) for (let k = 0; k < phrase.length; k++) negCover.add(i + k)
      i += phrase.length - 1
      continue
    }
    // ", no," : a "no" set off by pause marks on both sides is a correction ("the blue, no, the green").
    if (tokens[i].low === 'no' && i > 0 && tokens[i].pause && tokens[i + 1]?.pause) {
      spans.push([i, i]); cover.add(i); negCover.add(i)
    }
  }
  return { cover, negCover, spans }
}

/** Spoken numbers to digits: "twenty five" is 25, "twenty twenty six" is 20 then 26. */
function numberRun(tokens: Tok[], i: number): { value: number; end: number } | null {
  const first = tokens[i].low
  if (!ONES.has(first) && !TENS.has(first) && !(SCALES.has(first) && first !== 'k')) return null
  let total = 0, group = 0, last: 'ones' | 'tens' | 'scale' | null = null, teen = false, j = i
  for (; j < tokens.length; j++) {
    const w = tokens[j].low
    if (w === 'and' && last === 'scale' && (ONES.has(tokens[j + 1]?.low ?? '') || TENS.has(tokens[j + 1]?.low ?? ''))) continue
    if (TENS.has(w)) {
      if (last === 'ones' || last === 'tens') break
      group += TENS.get(w)!; last = 'tens'
    } else if (ONES.has(w)) {
      const v = ONES.get(w)!
      if (last === 'ones' || (last === 'tens' && (v >= 10 || v === 0)) || (teen && last !== 'scale')) break
      group += v; last = 'ones'; if (v >= 10) teen = true
    } else if (SCALES.has(w) && !(w === 'k' && last === null)) {
      const s = SCALES.get(w)!
      if (s === 100) group = (group || 1) * 100
      else { total += (group || 1) * s; group = 0 }
      last = 'scale'; teen = false
    } else break
  }
  return { value: total + group, end: j - 1 }
}

interface Extract { items: Item[]; tokens: Tok[] }

function extract(text: string, knownPhrases: string[][], withNames: boolean): Extract {
  const tokens = tokenize(normalize(text))
  const { negCover } = markers(tokens)
  const items: Item[] = []
  const midCapital = new Set(tokens.filter(t => !t.sentenceStart && /\p{Lu}/u.test(t.raw)).map(t => fold(t.low)))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // Negations.
    if (!negCover.has(i)) {
      if (t.low === 'not' || t.low === 'cannot' || /n't$/.test(t.low)) items.push({ kind: 'negation', key: 'NEG', pos: i })
      else if (NEG_WORDS.has(t.low)) items.push({ kind: 'negation', key: t.low, pos: i })
    }
    // Numbers.
    if (/^\d+$/.test(t.low)) {
      let value = Number.parseInt(t.low, 10)
      if (tokens[i + 1]?.low === 'k') value *= 1000
      items.push({ kind: 'number', key: String(value), pos: i })
      continue
    }
    const suffixed = /^(\d+)(st|nd|rd|th)$/.exec(t.low)
    if (suffixed) { items.push({ kind: 'number', key: String(Number.parseInt(suffixed[1], 10)), pos: i }); continue }
    // Digits inside a word ("Jewel360", "Q4", "iTerm2") are numbers too, so "jewel three sixty"
    // written "Jewel360" keeps its 3 and 60 (joined), and the word is still checked as a name below.
    if (/\p{L}/u.test(t.low) && /\d/.test(t.low)) {
      for (const digits of t.low.match(/\d+/g) ?? []) items.push({ kind: 'number', key: String(Number.parseInt(digits, 10)), pos: i })
    }
    const run = numberRun(tokens, i)
    if (run) {
      items.push({ kind: 'number', key: String(run.value), pos: i })
      i = run.end
      continue
    }
    if (ORDINALS.has(t.low)) { items.push({ kind: 'number', key: String(ORDINALS.get(t.low)), pos: i }); continue }
    if (NUMBER_WORDS.has(t.low)) { items.push({ kind: 'number', key: NUMBER_WORDS.get(t.low)!, pos: i }); continue }
    if (SYMBOLS.has(t.raw)) { items.push({ kind: 'number', key: SYMBOLS.get(t.raw)!, pos: i }); continue }
    if ((t.low === 'am' || t.low === 'pm') && i > 0 && (/^\d/.test(tokens[i - 1].low) || ONES.has(tokens[i - 1].low) || TENS.has(tokens[i - 1].low))) {
      items.push({ kind: 'number', key: t.low, pos: i }); continue
    }
    // Dates.
    const date = WEEKDAYS.get(t.low) ?? MONTHS.get(t.low)
    if (date && (!DATE_NEEDS_CAPITAL.has(t.low) || /^\p{Lu}/u.test(t.raw))) { items.push({ kind: 'date', key: date, pos: i }); continue }
    // Names: a mid-sentence capital (or a sentence-initial one the text capitalizes elsewhere too).
    if (withNames && /\p{Lu}/u.test(t.raw) && t.raw.length >= 2 && !NOT_NAMES.has(t.low) && !ONES.has(t.low) && !TENS.has(t.low)
      && !SCALES.has(t.low) && !ORDINALS.has(t.low) && !NUMBER_WORDS.has(t.low) && !NEG_WORDS.has(t.low)) {
      if (!t.sentenceStart || midCapital.has(fold(t.low))) items.push({ kind: 'name', key: fold(t.low), pos: i })
    }
  }
  // Dictionary terms and speaker names, in any case and position, as whole phrases.
  if (withNames) {
    for (const phrase of knownPhrases) {
      for (let i = 0; i + phrase.length <= tokens.length; i++) {
        if (phrase.every((w, k) => fold(tokens[i + k].low) === w)) items.push({ kind: 'name', key: phrase.join(' '), pos: i })
      }
    }
  }
  return { items, tokens }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** Mostly English? A short text is assumed to be; a long one with few English function words is not. */
export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length && letters.filter(ch => !/[A-Za-z]/.test(ch)).length / letters.length > 0.2) return false
  const words = tokenize(text).map(t => t.low)
  // A short command ("ask Marco about the deck") has few function words; only a longer text can tell.
  if (words.length < 12) return true
  return words.filter(w => ENGLISH.has(w)).length / words.length >= 0.12
}

const zero = (): Record<MeaningGuardKind, number> => ({ negation: 0, number: 0, date: 0, name: 0 })

/**
 * The first kind the answer lost or added, with counts, or null when every guarded token the
 * speaker kept is still there. `known` is the dictionary (vocabulary) and the speaker names.
 */
export function meaningGuardProblem(cleaned: string, answer: string, known: string[] = []): MeaningGuardProblem | null {
  if (typeof cleaned !== 'string' || typeof answer !== 'string') return null
  const knownPhrases = known.filter(k => typeof k === 'string' && k.trim())
    .map(k => tokenize(normalize(k)).map(t => fold(t.low))).filter(p => p.length > 0)
  const withNames = looksEnglish(cleaned)
  const input = extract(cleaned, knownPhrases, withNames)
  const output = extract(answer, knownPhrases, withNames)
  const outKeys = new Map<MeaningGuardKind, Set<string>>(MEANING_GUARD_KINDS.map(k => [k, new Set(output.items.filter(i => i.kind === k).map(i => i.key))]))
  const inKeys = new Map<MeaningGuardKind, Set<string>>(MEANING_GUARD_KINDS.map(k => [k, new Set(input.items.filter(i => i.kind === k).map(i => i.key))]))
  const { spans } = markers(input.tokens)

  // Spoken digits joined in the answer ("twenty twenty six" as "2026", "nineteen ninety" as "1990").
  const inNumbers = input.items.filter(i => i.kind === 'number' && /^\d+$/.test(i.key)).sort((a, b) => a.pos - b.pos)
  const joined = new Map<string, string[]>()
  for (let i = 0; i < inNumbers.length; i++) {
    for (const len of [2, 3]) {
      const group = inNumbers.slice(i, i + len)
      if (group.length === len && group.every((g, k) => k === 0 || g.pos - group[k - 1].pos <= 2)) joined.set(group.map(g => g.key).join(''), group.map(g => g.key))
    }
  }
  const outNumbers = outKeys.get('number')!
  const keptByJoin = new Set<string>()
  const joinedOut = new Set<string>()
  for (const key of outNumbers) {
    const parts = joined.get(key)
    if (parts && !inKeys.get('number')!.has(key)) { parts.forEach(p => keptByJoin.add(p)); joinedOut.add(key) }
  }

  // Names the answer re-spelled: to a dictionary term, or to a near form it was asked to fix.
  const outTokens = output.tokens
  const inTokenSet = new Set(input.tokens.map(t => fold(t.low)))
  const outJoined = new Set<string>()
  for (let i = 0; i < input.tokens.length; i++) {
    for (const len of [2, 3]) if (i + len <= input.tokens.length) outJoined.add(input.tokens.slice(i, i + len).map(t => fold(t.low).replace(/'/g, '')).join(''))
  }
  const nameKept = (key: string): boolean => {
    if (outKeys.get('name')!.has(key)) return true
    // Folded on both sides: a plural fold turns "bottlepos" into "bottlepo" on the answer's side too.
    const outWords = [...new Set(outTokens.map(t => fold(t.low).replace(/'/g, '')))]
    const flat = key.replace(/[' ]/g, '')
    if (outWords.includes(fold(flat))) return true
    // Joined into one word ("Hub Spot" as "HubSpot").
    if (outWords.some(w => outJoined.has(w) && w.includes(flat))) return true
    const knownFlat = knownPhrases.map(p => p.join(''))
    const respelled = outTokens.some(t => {
      const w = fold(t.low)
      if (inTokenSet.has(w)) return false
      if (knownFlat.includes(w)) return levenshtein(flat, w) <= Math.max(2, Math.floor(flat.length / 2))
      return /\p{Lu}/u.test(t.raw) && levenshtein(flat, w) <= Math.max(1, Math.floor(flat.length / 4))
    })
    return respelled
  }

  // A dropped token with a correction marker after it and a same-kind replacement the answer kept.
  const exempt = (item: Item): boolean => {
    if (item.kind === 'negation') return false
    for (const [start, end] of spans) {
      if (start <= item.pos || start - item.pos > DROP_TO_MARKER) continue
      const replaced = input.items.some(r => r.kind === item.kind && r.key !== item.key && r.pos > end && r.pos - end <= MARKER_TO_REPLACEMENT
        && (r.kind === 'name' ? nameKept(r.key) : outKeys.get(r.kind)!.has(r.key)))
      if (replaced) return true
    }
    return false
  }

  const dropped = zero()
  const added = zero()
  const seen = new Set<string>()
  for (const item of input.items) {
    const id = `${item.kind}:${item.key}`
    if (seen.has(id)) continue
    const kept = item.kind === 'name' ? nameKept(item.key)
      : outKeys.get(item.kind)!.has(item.key) || (item.kind === 'number' && keptByJoin.has(item.key))
    if (kept) { seen.add(id); continue }
    // Every occurrence must be exempt for a drop to be excused.
    const occurrences = input.items.filter(i => i.kind === item.kind && i.key === item.key)
    seen.add(id)
    if (occurrences.every(exempt)) continue
    dropped[item.kind]++
  }
  for (const key of outKeys.get('negation')!) if (!inKeys.get('negation')!.has(key)) added.negation++
  for (const key of outNumbers) if (!inKeys.get('number')!.has(key) && !joinedOut.has(key)) added.number++

  const kind = MEANING_GUARD_KINDS.find(k => dropped[k] > 0 || added[k] > 0)
  return kind ? { kind, dropped, added, namesSkipped: !withNames } : null
}

/** "negation=0/1 number=..." (dropped/added) for the log: counts only, never a word. */
export function meaningGuardCounts(problem: MeaningGuardProblem): string {
  return MEANING_GUARD_KINDS.map(k => `${k}=${problem.dropped[k]}/${problem.added[k]}`).join(' ')
}
