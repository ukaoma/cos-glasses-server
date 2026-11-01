// General live cues, privacy side: the sensitive-window skip and the deterministic query admission.
//
// General cues are the first automatic path from spoken words to a web search (validation 3, blocker 1). The existing
// public-search gate cannot be reused: it admits a word only because the USER typed it, and a topic the model picked was
// typed by nobody. So this module is the whole defence, and every rule in it is deterministic, local and runs without a
// model: a window with private-life vocabulary never leaves the machine, and a query is admitted only when it has no digit,
// no amount, no deny-list word, no person's name (speaker, owner), none of the owner's own terms (a whole vocabulary or
// domain-keyword term, never one word of it) and no repeat. It holds no real names: the names it blocks come from the live
// transcript and the owner's profile at run time.
import { createHash } from 'node:crypto'
import { redactSecrets } from './lens-gist-engines.js'
import { PRIVATE_QUERY } from './meeting-public-topic.js'
import { speakerNameWords, factWords, stemWord } from './meeting-fact-check.js'
import { HOME_AREA_LABEL, getDomainKeywords, getOwnerName, getOwnerSpeakerLabel, getVocabulary } from './profile.js'

export const GENERAL_QUERY_MAX_CHARS = 80
export const GENERAL_QUERY_MAX_WORDS = 8

// ── Sensitive window ────────────────────────────────────────────────────────
/** A trailing * is a stem ("pregnan*" is pregnant, pregnancy). Whole words only, so "son" never matches "reason". */
const wordsRe = (words: string[]): RegExp => new RegExp(`\\b(?:${words.map(w => w.endsWith('*') ? `${w.slice(0, -1)}\\w*` : w).join('|')})\\b`, 'i')
export type SensitiveCategory = 'health' | 'family' | 'finance' | 'legal' | 'school' | 'funeral'
const SENSITIVE: ReadonlyArray<readonly [SensitiveCategory, RegExp]> = [
  ['health', wordsRe(['health*', 'medical', 'medicine*', 'medication*', 'doctor*', 'hospital*', 'clinic*', 'diagnos*', 'therap*', 'surger*', 'pregnan*',
    'prescription*', 'cancer', 'illness*', 'symptom*', 'dentist*', 'nurse*', 'sick', 'injur*', 'anxiety', 'depress*'])],
  ['family', wordsRe(['family', 'families', 'wife', 'husband', 'spouse', 'daughter*', 'son', 'sons', 'kid', 'kids', 'child', 'children', 'baby', 'babies',
    'mom', 'mother*', 'dad', 'father*', 'brother*', 'sister*', 'parents', 'grandma', 'grandmother*', 'grandpa', 'grandfather*', 'aunt', 'uncle',
    'cousin*', 'birthday*', 'wedding*', 'newborn'])],
  ['finance', wordsRe(['financ*', 'tax', 'taxes', 'taxed', 'irs', 'debt*', 'loan*', 'mortgage*', 'salary', 'salaries', 'payroll', 'paycheck*', 'bankrupt*',
    'retirement', '401k', '403b', 'inheritance', 'net worth'])],
  ['legal', wordsRe(['legal*', 'lawsuit*', 'sue', 'sued', 'suing', 'lawyer*', 'attorney*', 'court', 'courts', 'courtroom*', 'subpoena*', 'divorce*', 'custody', 'settlement*', 'litigation'])],
  ['school', wordsRe(['school*', 'daycare*', 'preschool*', 'kindergarten*', 'teacher*', 'tuition', 'homework'])],
  ['funeral', wordsRe(['funeral*', 'obituar*', 'burial*', 'cemetery', 'died', 'passed\\s+away', 'death*', 'grief', 'mourning', 'casket', 'condolence*'])],
]
const SENSITIVE_ALL = new RegExp(SENSITIVE.map(([, re]) => re.source).join('|'), 'i')

/** The private-life category a transcript window touches, or null. Private-life vocabulary only: the owner's profile terms
 *  never skip a window. Measured on the saved windows, even whole-term matching skipped a third of the work windows that
 *  pass the trigger and word matching skipped all of them; the profile's terms guard the QUERY instead (ownerTermPhrases). */
export function sensitiveWindow(text: string): SensitiveCategory | null {
  for (const [category, re] of SENSITIVE) if (re.test(text)) return category
  return null
}

// ── Names from the profile and the live transcript ──────────────────────────
/** What the profile offers: the owner's name and speaker label, the terms the owner taught the decoder (names of people,
 *  companies, products, and plain work words inside longer terms), and the domain keyword lists (the owner's own
 *  organizations and brands; empty on the owner's real profile). Injectable for tests. */
export interface ProfileNameSource {
  ownerName(): string
  speakerLabel(): string
  vocabulary(): string[]
  domainKeywords(): Record<string, string[]>
}
export const realProfileNames: ProfileNameSource = {
  ownerName: getOwnerName, speakerLabel: getOwnerSpeakerLabel, vocabulary: getVocabulary, domainKeywords: getDomainKeywords,
}
const GENERIC_LABELS = new Set(['you', 'ext', 'unidentified', 'speaker', 'me', 'note', 'notes'])
/** The owner's own terms, each as its stemmed lowercase words: every vocabulary term and every domain-keyword term (and each
 *  domain name). A query is rejected only when it carries a WHOLE term as a phrase (admitCueTopic), never one word of it:
 *  the real vocabulary holds plain work words ("pos", "retail") inside longer terms, and blocking those one by one would
 *  reject every work query. A term under three characters is ignored (a stray letter would match everything). */
export function ownerTermPhrases(src: ProfileNameSource = realProfileNames): string[][] {
  const raw: string[] = []
  try { raw.push(...src.vocabulary()) } catch { /* no vocabulary */ }
  try { for (const [domain, words] of Object.entries(src.domainKeywords())) raw.push(domain.replace(/_/g, ' '), ...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }
  const seen = new Set<string>(), out: string[][] = []
  for (const term of raw) {
    const words = factWords(term).map(stemWord), key = words.join(' ')
    if (key.replace(/ /g, '').length < 3 || seen.has(key)) continue
    seen.add(key)
    out.push(words)
  }
  return out
}
/** Every name word a query must not carry, one word at a time: the owner and their label, the speakers the host knows, and
 *  the speaker labels that open lines of the window itself. Lowercase. (The profile's vocabulary is NOT here: see ownerTermPhrases.) */
export function blockedNameWords(window: string, speakers: readonly string[] = [], src: ProfileNameSource = realProfileNames): Set<string> {
  const names: string[] = [...speakers]
  try { names.push(src.ownerName(), src.speakerLabel()) } catch { /* no profile */ }
  for (const m of window.matchAll(/^\s*(?:\[\d+\]\s*)?\*{0,2}(\p{Lu}[\p{L}'’.-]{0,24}(?:\s+\p{Lu}[\p{L}'’.-]{0,24}){0,2})\*{0,2}\s*:/gmu)) names.push(m[1])
  return speakerNameWords([], names.filter(n => !GENERIC_LABELS.has(n.trim().toLowerCase())))
}

// ── Query admission ─────────────────────────────────────────────────────────
const NUMBER_WORD = wordsRe(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
  'million', 'billion', 'trillion', 'dollar*', 'bucks', 'percent', 'cent', 'cents'])
const QUERY_CHARS = /^[\p{L}\p{M}][\p{L}\p{M}'’.&\- ]*$/u
const URLISH = /\b(?:https?|www)\b/i
export type AdmitReason = 'empty' | 'too_long' | 'too_many_words' | 'characters' | 'url' | 'digit' | 'number_word' | 'secret' | 'deny_word' | 'name' | 'owner_term' | 'repeat'
export interface AdmitContext {
  /** Lowercase name words from blockedNameWords(): each blocks on its own. */
  nameWords: ReadonlySet<string>
  /** The owner's own terms from ownerTermPhrases(): each blocks only as a whole phrase. */
  terms: ReadonlyArray<readonly string[]>
  /** Normalized queries already used in this meeting or by any meeting in the last 30 minutes. */
  recent: ReadonlySet<string>
}
export type AdmitResult = { ok: true; query: string; normalized: string } | { ok: false; reason: AdmitReason }

/** The form two queries are compared in: lowercase words only. */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
/** First 12 hex of sha256 of the normalized query: the only form of a query a trace row may carry. */
export function queryHash(query: string): string {
  return createHash('sha256').update(normalizeQuery(query)).digest('hex').slice(0, 12)
}

/** Rejects (never repairs) a topic query. In order: shape, then the content rules, then repeats. The first that fails decides. */
export function admitCueTopic(raw: string, ctx: AdmitContext): AdmitResult {
  const query = raw.replace(/\s+/g, ' ').trim()
  if (!query) return { ok: false, reason: 'empty' }
  if (query.length > GENERAL_QUERY_MAX_CHARS) return { ok: false, reason: 'too_long' }
  if (query.split(' ').length > GENERAL_QUERY_MAX_WORDS) return { ok: false, reason: 'too_many_words' }
  if (/\p{Nd}/u.test(query)) return { ok: false, reason: 'digit' }
  if (NUMBER_WORD.test(query)) return { ok: false, reason: 'number_word' }
  if (!QUERY_CHARS.test(query)) return { ok: false, reason: 'characters' }
  if (URLISH.test(query)) return { ok: false, reason: 'url' }
  if (query !== redactSecrets(query)) return { ok: false, reason: 'secret' }
  if (PRIVATE_QUERY.test(query) || SENSITIVE_ALL.test(query)) return { ok: false, reason: 'deny_word' }
  if (factWords(query).some(w => ctx.nameWords.has(w) || ctx.nameWords.has(stemWord(w)))) return { ok: false, reason: 'name' }
  const padded = ` ${factWords(query).map(stemWord).join(' ')} `
  if (ctx.terms.some(t => padded.includes(` ${t.join(' ')} `))) return { ok: false, reason: 'owner_term' }
  const normalized = normalizeQuery(query)
  if (ctx.recent.has(normalized)) return { ok: false, reason: 'repeat' }
  return { ok: true, query, normalized }
}

/** A local query gets the owner's city-level home area, only when the profile's label passes HOME_AREA_LABEL (letters,
 *  spaces and . , ' - only, so never an address). The caller admits the result again: the longer string is a new query. */
export function withHomeArea(query: string, area: string | null): string | null {
  const label = area?.replace(/\s+/g, ' ').trim() ?? ''
  if (!label || !HOME_AREA_LABEL.test(label)) return null
  return `${query} ${label.replace(/,/g, '')}`
}
