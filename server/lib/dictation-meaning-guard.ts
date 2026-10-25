/**
 * 6.91.0: the meaning guard (plan r2). Deterministic, after the polish model, beside the link
 * guard (dictation-format.ts polishLinkProblem), on the `message` and `prompt_draft` buckets, and
 * only where prompt v4 runs on Sonnet (the canaried pair; dictation-polish-pipeline.ts). Haiku,
 * Luna, any other model and prompt v3 get no guard, so their answers are 6.90.0's.
 *
 * Its input is `cleaned`, the text the model was given (after the dictionary, fuzzy and filler
 * passes), never the raw heard text, the same input the link guard uses. It compares SETS of
 * guarded tokens, in four kinds:
 * - negation: not / n't / cannot and the forms speech-to-text writes without an apostrophe ("dont",
 *   "cant"), all one NEG token; never, no, none, nothing, nobody, neither, nor, without, unless,
 *   except;
 * - number: digits, number words, ordinals ("twenty fifth" is 25, like "25th"), %, $, a digit with a
 *   scale word ("2 million" is two million, like "two million"), and clock times. A decimal point
 *   splits a number on both sides ("one point five" and "1.5" are both 1 then 5);
 * - times (6.91.1): every clock time, spoken or written, in the dictation and in the answer, is read
 *   as minutes since midnight: "ten thirty", "half past ten", "quarter to five", "ten o'clock",
 *   "10:30", "10:30 am", "ten thirty pm", "22:30", "twenty two thirty". Without am or pm an hour
 *   from 1 to 12 reads both ways, so "ten thirty pm" written "22:30" is kept and "ten thirty" written
 *   "11:30" is a changed number. am, pm and a trailing ":00" are format only: "at ten" written
 *   "at 10:00 am" is kept. A time is kept when the answer has the same time, when it is on the hour
 *   and the answer says just that hour (and the dictation said no am or pm), or when every part of
 *   it survives as a plain number ("nineteen fifty" written "1950");
 * - date: a weekday or a month;
 * - name: a mid-sentence capital, a dictionary term or a speaker name. A sentence-initial word and
 *   "I" are not names unless they are dictionary terms. Skipped for a dictation that is not English.
 *
 * Normalization: case-insensitive; split on - / @ . and every other mark; number words become
 * digits ("twenty twenty six" may come back as "2026"); possessives and plurals fold; a name
 * re-spelled to a dictionary term (or to a near form the model was asked to fix) counts as kept.
 *
 * It trips on a DROPPED token of any kind, and on an ADDED negation or number. With no correction
 * marker in the dictation, negations are COUNTED ("not saying we should not ship" losing one "not"
 * trips; a stutter, the same negation twice in a row, counts once); with one, they are compared as
 * sets. A dropped token is exempt only when a correction marker follows it and a token of the SAME
 * kind replaces it within a few words ("five, actually six"; "Priya ... actually Dana"; "Tuesday,
 * no wait, Wednesday"). "actually" alone is a marker only when punctuation sets it off or the
 * replacement follows within 3 words; "wait" alone only when punctuation sets it off, because it is
 * an ordinary verb ("tell Marco to wait for Dana"). A negation is never exempt; only a marker
 * phrase's own words ("no wait", "wait no", ", no,", "never mind") are not negations. When the
 * speaker asked for a list ("numbered list", "number one", "bullet points"), a list number at the
 * start of a line ("1." or "2)") is never an added number. Known gaps, stated and not claimed:
 * reordering, before/after/only, and a list number standing in for a dropped number of the same
 * value. Pure; it never throws on strings and logs nothing.
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

interface Tok { raw: string; low: string; sentenceStart: boolean; pause: boolean; listMarker: boolean; colonNext: boolean }
interface Item { kind: MeaningGuardKind; key: string; pos: number; list?: boolean; inTime?: boolean; time?: TimeSpan }
/** A clock time: the tokens it covers, its minutes since midnight (two readings without am/pm), its parts. */
interface TimeSpan { start: number; end: number; times: number[]; explicit: boolean; parts: string[] }

const ONES = new Map(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((w, i) => [w, i]))
const TENS = new Map([['twenty', 20], ['thirty', 30], ['forty', 40], ['fourty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90]])
const SCALES = new Map([['hundred', 100], ['thousand', 1_000], ['k', 1_000], ['million', 1_000_000], ['billion', 1_000_000_000]])
const ORDINALS = new Map([['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5], ['sixth', 6], ['seventh', 7], ['eighth', 8],
  ['ninth', 9], ['tenth', 10], ['eleventh', 11], ['twelfth', 12], ['thirteenth', 13], ['fourteenth', 14], ['fifteenth', 15],
  ['sixteenth', 16], ['seventeenth', 17], ['eighteenth', 18], ['nineteenth', 19], ['twentieth', 20], ['thirtieth', 30], ['fortieth', 40],
  ['fiftieth', 50], ['sixtieth', 60], ['seventieth', 70], ['eightieth', 80], ['ninetieth', 90]])
/** Unit and time words that are part of a number item. */
const NUMBER_WORDS = new Map([['percent', 'percent'], ['percentage', 'percent'], ['dollar', 'dollar'], ['dollars', 'dollar'], ['buck', 'dollar'],
  ['bucks', 'dollar'], ['euro', 'euro'], ['euros', 'euro'], ['pound', 'pound'], ['pounds', 'pound'], ['cent', 'cent'], ['cents', 'cent'],
  ['noon', 'noon'], ['midnight', 'midnight']])
const SYMBOLS = new Map([['%', 'percent'], ['$', 'dollar'], ['€', 'euro'], ['£', 'pound'], ['¢', 'cent']])

const NEG_WORDS = new Set(['never', 'no', 'none', 'nothing', 'nobody', 'neither', 'nor', 'without', 'unless', 'except'])
/** "n't" forms speech-to-text writes without the apostrophe: the same NEG token as "don't". */
const BARE_NT = new Set(['dont', 'cant', 'wont', 'isnt', 'arent', 'doesnt', 'didnt', 'wasnt', 'werent', 'shouldnt', 'wouldnt', 'couldnt',
  'havent', 'hasnt', 'hadnt', 'mustnt', 'neednt', 'aint'])

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
/** One-word markers that are also ordinary words: a marker only when set off (see markers()). */
const BARE_ACTUALLY = 'actually'
const BARE_WAIT = 'wait'
const DROP_TO_MARKER = 8
const MARKER_TO_REPLACEMENT = 6
/** A bare "actually" (no punctuation around it) excuses a drop only with a replacement this close. */
const BARE_MARKER_TO_REPLACEMENT = 3
/** The speaker asked for a list, so line-start list numbers are formatting, not added numbers. */
const LIST_ASKED = /\b(?:numbered list|number one|bullet(?:ed)? (?:list|points?)|bullets)\b/i

const ENGLISH = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'it', 'this',
  'that', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'our', 'your', 'their', 'can', 'will', 'do', 'does', 'not', 'at', 'from', 'have', 'has',
  'me', 'us', 'so', 'if', 'what', 'just', 'about', 'there', 'here', 'all', 'some', 'any', 'how', 'why', 'when', 'need', 'want', 'get', 'make'])

const HOUR = '(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2})'
const HALF_PAST = new RegExp(`\\bhalf past ${HOUR}\\b`, 'gi')
const QUARTER_PAST = new RegExp(`\\b(?:a )?quarter (?:past|after) ${HOUR}\\b`, 'gi')
const QUARTER_TO = new RegExp(`\\b(?:a )?quarter (?:to|of|till|til) ${HOUR}\\b`, 'gi')

/** An hour from 1 to 12, as a word or digits, or null. */
function hourOf(word: string): number | null {
  const value = ONES.get(word.toLowerCase()) ?? (/^\d+$/.test(word) ? Number.parseInt(word, 10) : -1)
  return value >= 1 && value <= 12 ? value : null
}

/** "half past ten" is 10:30, "quarter past ten" 10:15, "quarter to five" 4:45 (and "quarter to one" 12:45). */
function spokenTimes(text: string): string {
  return text
    .replace(HALF_PAST, (all, h: string) => { const hour = hourOf(h); return hour === null ? all : `${hour}:30` })
    .replace(QUARTER_PAST, (all, h: string) => { const hour = hourOf(h); return hour === null ? all : `${hour}:15` })
    .replace(QUARTER_TO, (all, h: string) => { const hour = hourOf(h); return hour === null ? all : `${hour === 1 ? 12 : hour - 1}:45` })
}

function normalize(text: string): string {
  return spokenTimes(text)
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
    // "1." or "2)" at the start of a line: a list number.
    const listMarker = /^\d+$/.test(m[0]) && /(?:^|\n)[ \t]*$/.test(text.slice(0, m.index)) && /^[.)]/.test(text.slice(m.index + m[0].length))
    const colonNext = /^:\d/.test(text.slice(m.index + m[0].length))
    out.push({ raw: m[0], low: m[0].toLowerCase(), sentenceStart, pause: /[,;.!?—–()]/.test(gap), listMarker, colonNext })
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

/** A correction marker: where it starts and ends, how close its replacement must follow, and whether it stood alone. */
interface Span { start: number; end: number; reach: number; bare: boolean }

/** The correction markers, and the positions of the ones whose own words are not negations. */
function markers(tokens: Tok[]): { negCover: Set<number>; spans: Span[] } {
  const negCover = new Set<number>()
  const spans: Span[] = []
  for (let i = 0; i < tokens.length; i++) {
    const phrase = MARKERS.find(p => startsWith(tokens, i, p))
    if (phrase) {
      // "actually" and "wait" alone are ordinary words unless punctuation sets them off
      // ("Priya, actually Dana"; "Tuesday wait, Wednesday"). A bare "actually" still counts when the
      // replacement follows within BARE_MARKER_TO_REPLACEMENT words ("five actually six"); a bare
      // "wait" never does ("tell Marco to wait for Dana" keeps Marco).
      const bare = phrase.length === 1 && (phrase[0] === BARE_ACTUALLY || phrase[0] === BARE_WAIT)
        && !tokens[i].pause && !tokens[i + 1]?.pause
      if (bare && phrase[0] === BARE_WAIT) continue
      spans.push({ start: i, end: i + phrase.length - 1, reach: bare ? BARE_MARKER_TO_REPLACEMENT : MARKER_TO_REPLACEMENT, bare })
      if (NEG_MARKER_PHRASES.some(p => p.length === phrase.length && startsWith(tokens, i, p))) for (let k = 0; k < phrase.length; k++) negCover.add(i + k)
      i += phrase.length - 1
      continue
    }
    // ", no," : a "no" set off by pause marks on both sides is a correction ("the blue, no, the green").
    if (tokens[i].low === 'no' && i > 0 && tokens[i].pause && tokens[i + 1]?.pause) {
      spans.push({ start: i, end: i, reach: MARKER_TO_REPLACEMENT, bare: false }); negCover.add(i)
    }
  }
  return { negCover, spans }
}

/**
 * Spoken numbers to digits: "twenty five" is 25, "twenty twenty six" is 20 then 26. An ordinal
 * ends a run: "twenty fifth" is 25 (as "25th" is), "one hundred and first" 101.
 */
function numberRun(tokens: Tok[], i: number): { value: number; end: number } | null {
  const first = tokens[i].low
  if (!ONES.has(first) && !TENS.has(first) && !(SCALES.has(first) && first !== 'k')) return null
  let total = 0, group = 0, last: 'ones' | 'tens' | 'scale' | null = null, teen = false, j = i
  for (; j < tokens.length; j++) {
    const w = tokens[j].low
    const next = tokens[j + 1]?.low ?? ''
    if (w === 'and' && last === 'scale' && (ONES.has(next) || TENS.has(next) || ORDINALS.has(next))) continue
    if (ORDINALS.has(w)) {
      const v = ORDINALS.get(w)!
      if (!((last === 'tens' && v < 10) || last === 'scale')) break
      group += v
      j++
      break
    }
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

const MERIDIEM = new Set(['am', 'pm'])

/** Minutes since midnight: one reading with am/pm or a 24-hour hour, both readings for 1 to 12 without. */
function clockMinutes(hour: number, minute: number, meridiem: string | undefined): { times: number[]; explicit: boolean } {
  if (meridiem && hour >= 1 && hour <= 12) return { times: [((hour % 12) + (meridiem === 'pm' ? 12 : 0)) * 60 + minute], explicit: true }
  if (hour >= 1 && hour <= 12) return { times: [(hour % 12) * 60 + minute, ((hour % 12) + 12) * 60 + minute], explicit: false }
  return { times: [hour * 60 + minute], explicit: true }
}

/** The readings of a bare hour ("ten" or "10") as a time on the hour. */
function hourReadings(n: number): number[] {
  if (n >= 1 && n <= 12) return [(n % 12) * 60, ((n % 12) + 12) * 60]
  return n === 0 || (n >= 13 && n <= 23) ? [n * 60] : []
}

/** A spoken hour: one to nineteen, twenty, twenty one to twenty three. */
function spokenHour(tokens: Tok[], i: number): { value: number; end: number } | null {
  const w = tokens[i]?.low ?? ''
  const v = ONES.get(w)
  if (v !== undefined) return v >= 1 ? { value: v, end: i } : null
  if (w !== 'twenty') return null
  const ones = ONES.get(tokens[i + 1]?.low ?? '')
  return ones !== undefined && ones >= 1 && ones <= 3 ? { value: 20 + ones, end: i + 1 } : { value: 20, end: i }
}

/** Spoken minutes after an hour: "oh five", ten to nineteen, twenty to fifty nine. */
function spokenMinutes(tokens: Tok[], i: number): { value: number; end: number } | null {
  const w = tokens[i]?.low ?? ''
  const next = ONES.get(tokens[i + 1]?.low ?? '')
  if (w === 'oh' || w === 'o') return next !== undefined && next >= 1 && next <= 9 ? { value: next, end: i + 1 } : null
  const v = ONES.get(w)
  if (v !== undefined) return v >= 10 ? { value: v, end: i } : null
  const tens = TENS.get(w)
  if (tens === undefined || tens > 50) return null
  return next !== undefined && next >= 1 && next <= 9 ? { value: tens + next, end: i + 1 } : { value: tens, end: i }
}

/** One clock time starting at token i, or null. An hour alone is not a time; it needs minutes or am/pm. */
function timeAt(tokens: Tok[], i: number): Omit<TimeSpan, 'parts'> | null {
  const t = tokens[i]
  let hour: number, end: number
  if (/^\d{1,2}$/.test(t.low)) { hour = Number.parseInt(t.low, 10); end = i }
  else { const h = spokenHour(tokens, i); if (!h) return null; hour = h.value; end = h.end }
  let minute = 0, hasMinutes = false
  const next = tokens[end + 1]?.low ?? ''
  if (tokens[end].colonNext && /^\d{2}$/.test(next)) { minute = Number.parseInt(next, 10); end++; hasMinutes = true }
  else if (!/^\d/.test(t.low)) { const m = spokenMinutes(tokens, end + 1); if (m) { minute = m.value; end = m.end; hasMinutes = true } }
  const meridiem = MERIDIEM.has(tokens[end + 1]?.low ?? '') ? tokens[end + 1].low : undefined
  if (!hasMinutes && !meridiem) return null
  if (meridiem) end++
  if (hour > 23 || minute > 59) return null
  const { times, explicit } = clockMinutes(hour, minute, meridiem)
  return { start: i, end, times, explicit }
}

/** Every clock time in the text, as time items; the number items inside one become its parts. */
function addTimes(tokens: Tok[], items: Item[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const found = timeAt(tokens, i)
    if (!found) continue
    const parts = items.filter(it => it.kind === 'number' && it.pos >= found.start && it.pos <= found.end)
    parts.forEach(it => { it.inTime = true })
    const time: TimeSpan = { ...found, parts: parts.map(it => it.key) }
    items.push({ kind: 'number', key: `time:${time.times.join('/')}`, pos: found.start, time })
    i = found.end
  }
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
      if (t.low === 'not' || t.low === 'cannot' || /n't$/.test(t.low) || BARE_NT.has(t.low)) items.push({ kind: 'negation', key: 'NEG', pos: i })
      else if (NEG_WORDS.has(t.low)) items.push({ kind: 'negation', key: t.low, pos: i })
    }
    // Numbers.
    if (/^\d+$/.test(t.low)) {
      let value = Number.parseInt(t.low, 10)
      const pos = i
      // A digit and a scale word are one number: "2 million" is two million, as "two million" is.
      while (SCALES.has(tokens[i + 1]?.low ?? '')) { value *= SCALES.get(tokens[i + 1].low)!; i++ }
      items.push({ kind: 'number', key: String(value), pos, ...(t.listMarker ? { list: true } : {}) })
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
  addTimes(tokens, items)
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

/**
 * 6.92.0: common function words of German, Portuguese, Spanish, French and Dutch that are not
 * English words, not name particles or place words ("de", "la", "von", "Los", "Las") and not words
 * dictation says in English ("dot com", "em dash", "est", "eu"). Evidence that a short text is not
 * English. An all-caps token ("MIT") never counts.
 */
const FOREIGN = new Set(['der', 'das', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'ist', 'sind', 'nicht', 'ich', 'wir', 'ihr',
  'sie', 'mit', 'uns', 'auf', 'für', 'uhr', 'auch', 'noch', 'oder', 'aber', 'wie', 'kommt', 'heute', 'morgen', 'bitte', 'danke',
  'haben', 'wird', 'kann', 'zum', 'zur', 'bei', 'nach', 'ja', 'nein',
  'uma', 'não', 'nao', 'por', 'que', 'você', 'voce', 'ele', 'ela', 'nós', 'isso', 'este', 'esta', 'muito', 'obrigado', 'obrigada',
  'amanhã', 'hoje',
  'una', 'unos', 'está', 'pero', 'muy', 'gracias', 'mañana', 'hoy',
  'une', 'je', 'nous', 'vous', 'avec', 'pour', 'pas', 'mais', 'oui', 'merci',
  'het', 'een', 'ik', 'niet', 'wij', 'voor'])
/** 6.92.0: an English filler sound that is also a word in German, Portuguese, Danish, Norwegian or Dutch. */
const AMBIGUOUS_FILLERS = new Set(['um', 'er'])

/**
 * Mostly English? A long text needs English function words (12% of its words). 6.92.0 tightens a
 * short one (under 12 words), which was always assumed English: with a foreign function word in it,
 * English function words must outnumber the foreign ones ("Wir treffen uns um 5 Uhr" is not
 * English); with "um" or "er" said inline (no pause after it), at least one English function word
 * must be there ("Comprei um carro", "Er kommt morgen." are not; "ship it er tomorrow" is). With
 * neither, a short command is still English ("ping Marco re pricing"), so its names are checked.
 */
export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length && letters.filter(ch => !/[A-Za-z]/.test(ch)).length / letters.length > 0.2) return false
  const tokens = tokenize(text)
  const words = tokens.map(t => t.low)
  if (words.length >= 12) return words.filter(w => ENGLISH.has(w)).length / words.length >= 0.12
  // A short command ("ask Marco about the deck") has few function words; only evidence decides.
  const english = words.filter(w => ENGLISH.has(w)).length
  const foreign = tokens.filter(t => FOREIGN.has(t.low) && !(t.raw.length > 1 && t.raw === t.raw.toUpperCase())).length
  if (foreign > 0) return english > foreign
  const inlineAmbiguous = tokens.some((t, i) => AMBIGUOUS_FILLERS.has(t.low) && i + 1 < tokens.length && !tokens[i + 1].pause)
  if (inlineAmbiguous) return english > 0
  return true
}

const zero = (): Record<MeaningGuardKind, number> => ({ negation: 0, number: 0, date: 0, name: 0 })

/** How many of each negation, a stutter (the same one twice in a row) counted once. */
function negationCounts(items: Item[]): Map<string, number> {
  const counts = new Map<string, number>()
  let previous: Item | null = null
  for (const item of items.filter(i => i.kind === 'negation').sort((a, b) => a.pos - b.pos)) {
    if (!(previous && previous.key === item.key && item.pos === previous.pos + 1)) counts.set(item.key, (counts.get(item.key) ?? 0) + 1)
    previous = item
  }
  return counts
}

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
  // A bare "actually" is a marker only with a guarded word right after it ("five actually six");
  // "I actually think" is an ordinary adverb, so it neither excuses a drop nor stops the counts.
  const spans = markers(input.tokens).spans
    .filter(span => !span.bare || input.items.some(r => r.kind !== 'negation' && r.pos > span.end && r.pos - span.end <= span.reach))

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

  // 6.91.1: clock times, compared as minutes since midnight (see the header).
  const inTimes = input.items.filter(i => i.time).map(i => i.time!)
  const outTimes = output.items.filter(i => i.time).map(i => i.time!)
  const bareHours = (items: Item[]) => items.filter(i => i.kind === 'number' && !i.time && !i.inTime && /^\d+$/.test(i.key)).map(i => Number(i.key))
  const inBare = bareHours(input.items)
  const outBare = bareHours(output.items)
  const sameTime = (a: TimeSpan, b: TimeSpan) => a.times.some(t => b.times.includes(t))
  // A bare hour matches a time only on that hour: its readings are all on the hour.
  const onTheHour = (time: TimeSpan, n: number) => hourReadings(n).some(t => time.times.includes(t))
  const numberKept = (key: string) => outKeys.get('number')!.has(key) || keptByJoin.has(key)
  const timeKept = (time: TimeSpan) => outTimes.some(o => sameTime(time, o))
    || (!time.explicit && outBare.some(n => onTheHour(time, n)))
    || time.parts.every(numberKept)
  // A time in the answer is not new when the dictation had it, had its hour ("at ten" as "10:00 am"),
  // or had its parts as numbers. am, pm and ":00" are format only.
  const timeAccounted = (time: TimeSpan) => inTimes.some(i => sameTime(i, time))
    || inBare.some(n => onTheHour(time, n))
    || time.parts.filter(p => !MERIDIEM.has(p) && p !== '0').every(p => inKeys.get('number')!.has(p))
  const kept = (item: Item): boolean => item.kind === 'name' ? nameKept(item.key)
    : item.time ? timeKept(item.time)
    : item.kind === 'number' ? numberKept(item.key) || (/^\d+$/.test(item.key) && outTimes.some(o => onTheHour(o, Number(item.key))))
    : outKeys.get(item.kind)!.has(item.key)

  // A dropped token with a correction marker after it and a same-kind replacement the answer kept.
  const exempt = (item: Item): boolean => {
    if (item.kind === 'negation') return false
    for (const { start, end, reach } of spans) {
      if (start <= item.pos || start - item.pos > DROP_TO_MARKER) continue
      const replaced = input.items.some(r => r.kind === item.kind && r.key !== item.key && r.pos > end && r.pos - end <= reach && kept(r))
      if (replaced) return true
    }
    return false
  }

  // With no correction marker, negations are counted, so losing one of two "not"s trips. A
  // correction can legitimately drop a repeated negation ("can't, no wait, can't do Friday"), so
  // with a marker they are compared as sets, like every other kind.
  const countNegations = spans.length === 0

  const dropped = zero()
  const added = zero()
  const seen = new Set<string>()
  for (const item of input.items) {
    const id = `${item.kind}:${item.key}`
    if (seen.has(id)) continue
    if (item.kind === 'negation' && countNegations) continue
    // A number inside a clock time is judged with its time.
    if (item.inTime) continue
    if (kept(item)) { seen.add(id); continue }
    // Every occurrence must be exempt for a drop to be excused.
    const occurrences = input.items.filter(i => i.kind === item.kind && i.key === item.key)
    seen.add(id)
    if (occurrences.every(exempt)) continue
    dropped[item.kind]++
  }
  if (countNegations) {
    const inCounts = negationCounts(input.items)
    const outCounts = negationCounts(output.items)
    for (const [key, n] of inCounts) if ((outCounts.get(key) ?? 0) < n) dropped.negation += n - (outCounts.get(key) ?? 0)
    for (const [key, n] of outCounts) if ((inCounts.get(key) ?? 0) < n) added.negation += n - (inCounts.get(key) ?? 0)
  } else {
    for (const key of outKeys.get('negation')!) if (!inKeys.get('negation')!.has(key)) added.negation++
  }
  // A list the speaker asked for: its line-start numbers are formatting, never added numbers.
  const listOnly = new Set<string>()
  if (LIST_ASKED.test(cleaned)) {
    const outNumberItems = output.items.filter(i => i.kind === 'number')
    for (const key of outNumbers) if (outNumberItems.filter(i => i.key === key).every(i => i.list)) listOnly.add(key)
  }
  const plainOut = new Set(output.items.filter(i => i.kind === 'number' && !i.time && !i.inTime).map(i => i.key))
  for (const key of plainOut) if (!inKeys.get('number')!.has(key) && !joinedOut.has(key) && !listOnly.has(key)) added.number++
  for (const time of outTimes) if (!timeAccounted(time)) added.number++

  const kind = MEANING_GUARD_KINDS.find(k => dropped[k] > 0 || added[k] > 0)
  return kind ? { kind, dropped, added, namesSkipped: !withNames } : null
}

/** "negation=0/1 number=..." (dropped/added) for the log: counts only, never a word. */
export function meaningGuardCounts(problem: MeaningGuardProblem): string {
  return MEANING_GUARD_KINDS.map(k => `${k}=${problem.dropped[k]}/${problem.added[k]}`).join(' ')
}
