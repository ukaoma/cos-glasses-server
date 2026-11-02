// General live cues, privacy side: the sensitive-window skip and the deterministic query admission.
//
// General cues are the first automatic path from spoken words to a web search (validation 3, blocker 1). The existing
// public-search gate cannot be reused: it admits a word only because the USER typed it, and a topic the model picked was
// typed by nobody. So this module is the whole defence, and every rule in it is deterministic, local and runs without a
// model: a window with private-life vocabulary never leaves the machine, and a query is admitted only when it has no digit,
// no amount, no deny-list word, no person's name (speaker, owner), none of the owner's own terms (a whole vocabulary or
// domain-keyword term, never one word of it) and no repeat. It holds no real names: the names it blocks come from the live
// transcript, the speakers the ASR path reports, every enrolled voice profile and the owner's profile at run time.
//
// RESIDUAL RISK, by design: a private person who is named in the room but never speaks and is not enrolled is caught by no
// list here. Only the topic prompt's rule 2 (never a private person) stands between that name and the web. The speakers, the
// enrolled voices, the owner and the capitalized words of the calendar title are what the lists can know.
import { createHash } from 'node:crypto'
import { redactSecrets } from './lens-gist-engines.js'
import { PRIVATE_QUERY } from './meeting-public-topic.js'
import { speakerNameWords, factWords, stemWord } from './meeting-fact-check.js'
import { HOME_AREA_LABEL, getDomainKeywords, getOwnerName, getOwnerSpeakerLabel, getVocabulary } from './profile.js'

export const GENERAL_QUERY_MAX_CHARS = 80
export const GENERAL_QUERY_MAX_WORDS = 8

// ── Sensitive window ────────────────────────────────────────────────────────
/** What the lists are matched against: lowercase, compatibility-decomposed (NFKD does what NFKC does to full-width forms, so ＩＲＳ
 *  is irs) with the accents then dropped, dots inside an acronym dropped (I.R.S. becomes irs), hyphens, underscores and slashes
 *  read as spaces (C-section becomes c section). Pure. */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/\b(?:\p{L}\.){2,}\p{L}?/gu, m => m.replace(/\./g, ''))
    .replace(/[-_\u2010-\u2015/]+/g, ' ').replace(/\s+/g, ' ').trim()
}
/** A trailing * is a stem ("pregnan*" is pregnant, pregnancy). Whole words only, so "son" never matches "reason". Run on
 *  normalizeForMatch text. Stems stop where a longer word would be a public topic: no "mom*" (moment), "kid*" (kidney), "tax*"
 *  (taxi, taxonomy), "grand*" (Grand Prix) or "mother*" (motherboard). */
const wordsRe = (words: string[]): RegExp => new RegExp(`\\b(?:${words.map(w => w.endsWith('*') ? `${w.slice(0, -1)}\\w*` : w).join('|')})\\b`, 'i')
export type SensitiveCategory = 'health' | 'family' | 'finance' | 'legal' | 'school' | 'funeral'
const SENSITIVE: ReadonlyArray<readonly [SensitiveCategory, RegExp]> = [
  ['health', wordsRe(['health*', 'medical', 'medicine*', 'medication*', 'doctor*', 'hospital*', 'hospice', 'clinic*', 'diagnos*', 'therap*', 'surger*', 'pregnan*',
    'prescription*', 'pharmac*', 'cancer', 'chemo*', 'oncolog*', 'illness*', 'symptom*', 'dentist*', 'nurse', 'nurses', 'nursing', 'sick', 'injur*', 'anxiety', 'depress*',
    'psychiatr*', 'psycholog*', 'pediatric*', 'adhd', 'autis*', 'ob gyn', 'obgyn', 'c section', 'csection', 'miscarriage*', 'infertil*', 'ivf'])],
  ['family', wordsRe(['family', 'families', 'wife', 'wives', 'husband*', 'spouse*', 'daughter*', 'son', 'sons', 'kid', 'kids', 'kiddo', 'kiddos', 'child', 'children',
    'childcare', 'childhood', 'baby', 'babies', 'newborn', 'mom', 'moms', 'mommy', 'mum', 'mums', 'mother', 'mothers', 'motherhood', 'dad', 'dads', 'daddy',
    'father', 'fathers', 'fatherhood', 'parent*', 'brother*', 'sister*', 'sibling*', 'grandma*', 'grandpa*', 'grandmother*', 'grandfather*', 'grandparent*',
    'grandchild*', 'grandson*', 'granddaughter*', 'grandkid*', 'aunt*', 'uncle*', 'cousin*', 'nephew*', 'niece*', 'stepmom', 'stepdad', 'fiance*',
    'girlfriend', 'boyfriend', 'in laws', 'inlaws', 'birthday*', 'wedding*'])],
  ['finance', wordsRe(['financ*', 'tax', 'taxes', 'taxed', 'taxing', 'taxable', 'taxation', 'irs', 'debt*', 'loan*', 'mortgage*', 'installment*', 'escrow',
    'credit score', 'pension*', 'insurance', 'salary', 'salaries', 'payroll', 'paycheck*', 'bankrupt*', 'retirement', '401k', '403b', 'inheritance', 'net worth'])],
  ['legal', wordsRe(['legal*', 'lawsuit*', 'sue', 'sued', 'suing', 'lawyer*', 'attorney*', 'court', 'courts', 'courtroom*', 'subpoena*', 'divorce*', 'custody', 'settlement*', 'litigation'])],
  ['school', wordsRe(['school*', 'daycare*', 'preschool*', 'kindergarten*', 'nursery', 'pre k', 'prek', 'teacher*', 'tuition', 'homework', 'dnp', 'dissertation*', 'doctoral'])],
  ['funeral', wordsRe(['funeral*', 'obituar*', 'burial*', 'cemetery', 'die', 'dies', 'died', 'dying', 'passed away', 'death*', 'grief', 'mourning', 'casket', 'condolence*'])],
]
const SENSITIVE_ALL = new RegExp(SENSITIVE.map(([, re]) => re.source).join('|'), 'i')

/** The private-life category a transcript window touches, or null. Pure and exported so the saved windows can be replayed through
 *  it. Private-life vocabulary only: the owner's profile terms never skip a window. Measured on the saved windows, even
 *  whole-term matching skipped a third of the work windows that pass the trigger and word matching skipped all of them; the
 *  profile's terms guard the QUERY instead (ownerTermPhrases). */
export function sensitiveWindow(text: string): SensitiveCategory | null {
  const t = normalizeForMatch(text)
  for (const [category, re] of SENSITIVE) if (re.test(t)) return category
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
  /** Every enrolled voice profile's name (the store behind GET /api/voice/profiles). REJECTS or THROWS when the names cannot be
   *  read: a caller must then withhold, not guess. Absent means a source with no voice store (a test). */
  voiceProfileNames?(): string[] | Promise<string[]>
}
/** Wraps a reader so it is called at most once every `ttlMs`. A failed read propagates and is never papered over with the stale
 *  copy: the cache only answers inside its window. */
export function cachedNames(read: () => string[] | Promise<string[]>, ttlMs = 5 * 60_000, now: () => number = Date.now): () => Promise<string[]> {
  let cache: { at: number; names: string[] } | null = null
  return async () => {
    const t = now()
    if (cache && t - cache.at < ttlMs) return cache.names
    const names = await read()
    cache = { at: t, names }
    return names
  }
}
/** The real profile. Every accessor is a thunk, and the voice store is loaded on first use: this module is on the import path of
 *  every route that feeds live cues, and the speaker store pulls in the data home at load. */
export const realProfileNames: ProfileNameSource = {
  ownerName: () => getOwnerName(), speakerLabel: () => getOwnerSpeakerLabel(), vocabulary: () => getVocabulary(), domainKeywords: () => getDomainKeywords(),
  voiceProfileNames: cachedNames(async () => (await import('./speaker-embeddings.js')).readVoiceProfiles().profiles.map(p => p.name)),
}
/** A label the ASR or the transcript uses for "somebody": never a name to block (blocking "speaker" would reject queries). */
export function isGenericSpeakerLabel(label: string): boolean {
  return /^(?:you|ext|unidentified|unknown|me|mu|host|note|notes|(?:speaker|guest|voice)\s*\d*)$/i.test(label.trim())
}
const fold = (w: string): string => w.normalize('NFKD').replace(/\p{M}/gu, '')
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
    const words = factWords(fold(term)).map(stemWord), key = words.join(' ')
    if (key.replace(/ /g, '').length < 3 || seen.has(key)) continue
    seen.add(key)
    out.push(words)
  }
  return out
}
/** The same terms with the spaces taken out, unstemmed ("Bottle POS" is bottlepos, "IT Retail" is itretail): a query that writes
 *  a term as one word or as a different split of its words still carries it. Compared to the query's words and to its adjacent
 *  two-word joins (admitCueTopic): any longer split of a term is already caught as a phrase. */
export function ownerTermJoins(src: ProfileNameSource = realProfileNames): string[] {
  const raw: string[] = []
  try { raw.push(...src.vocabulary()) } catch { /* no vocabulary */ }
  try { for (const [domain, words] of Object.entries(src.domainKeywords())) raw.push(domain.replace(/_/g, ' '), ...(Array.isArray(words) ? words.filter(w => typeof w === 'string') : [])) } catch { /* none */ }
  return [...new Set(raw.map(t => factWords(fold(t)).join('')).filter(j => j.length >= 3))]
}
/** Every name word a query must not carry, one word at a time: the owner and their label, every enrolled voice profile, the
 *  speakers the ASR path reported (and the other names the host knows), and the speaker labels that open lines of the window
 *  itself. Lowercase, with accents folded as well. REJECTS when the voice profile names cannot be read (the caller withholds).
 *  The profile's vocabulary is NOT here: see ownerTermPhrases. */
export async function blockedNameWords(window: string, speakers: readonly string[] = [], src: ProfileNameSource = realProfileNames): Promise<Set<string>> {
  const names: string[] = [...speakers]
  try { names.push(src.ownerName(), src.speakerLabel()) } catch { /* no profile */ }
  if (src.voiceProfileNames) names.push(...await src.voiceProfileNames())
  for (const m of window.matchAll(/^\s*(?:\[\d+\]\s*)?\*{0,2}(\p{Lu}[\p{L}'’.-]{0,24}(?:\s+\p{Lu}[\p{L}'’.-]{0,24}){0,2})\*{0,2}\s*:/gmu)) names.push(m[1])
  const words = speakerNameWords([], names.filter(n => !isGenericSpeakerLabel(n)))
  return new Set([...words, ...[...words].map(fold)])
}

// ── Query admission ─────────────────────────────────────────────────────────
const NUMBER_WORD = wordsRe(['zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'hundreds', 'thousand',
  'thousands', 'million', 'millions', 'billion', 'billions', 'trillion', 'trillions', 'dozen', 'dozens', 'half', 'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'dollar*', 'bucks', 'percent', 'cent', 'cents'])
/** Latin script only: letters of another script can spell a word the lists above never see (a Cyrillic "a" inside "tax"). */
const QUERY_CHARS = /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}'’.&\- ]*$/u
const URLISH = /\b(?:https?|www)\b/i
export type AdmitReason = 'empty' | 'too_long' | 'too_many_words' | 'characters' | 'url' | 'digit' | 'number_word' | 'secret' | 'deny_word' | 'name' | 'owner_term' | 'repeat'
/** The rejections a trace row may carry a query hash for. Every other reason names a private word, name, number or secret, and a
 *  hash of a short query is a dictionary lookup away from the query itself. */
export const HASHABLE_REJECTIONS: ReadonlySet<AdmitReason> = new Set(['repeat', 'too_long', 'too_many_words'])
export interface AdmitContext {
  /** Lowercase name words from blockedNameWords(): each blocks on its own. */
  nameWords: ReadonlySet<string>
  /** The owner's own terms from ownerTermPhrases(): each blocks only as a whole phrase. */
  terms: ReadonlyArray<readonly string[]>
  /** The same terms with the spaces taken out (ownerTermJoins()): each blocks when a query word, or two adjacent query
   *  words written together, spell it. */
  joins: ReadonlyArray<string>
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

/** Rejects (never repairs) a topic query. In order: shape, then the content rules, then repeats. The first that fails decides.
 *  The query is read after NFKC, so full-width digits and letters are the plain ones the rules know. */
export function admitCueTopic(raw: string, ctx: AdmitContext): AdmitResult {
  const query = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!query) return { ok: false, reason: 'empty' }
  if (query.length > GENERAL_QUERY_MAX_CHARS) return { ok: false, reason: 'too_long' }
  if (query.split(' ').length > GENERAL_QUERY_MAX_WORDS) return { ok: false, reason: 'too_many_words' }
  if (/\p{Nd}/u.test(query)) return { ok: false, reason: 'digit' }
  const folded = normalizeForMatch(query)
  if (NUMBER_WORD.test(folded)) return { ok: false, reason: 'number_word' }
  if (!QUERY_CHARS.test(query)) return { ok: false, reason: 'characters' }
  if (URLISH.test(folded)) return { ok: false, reason: 'url' }
  if (query !== redactSecrets(query)) return { ok: false, reason: 'secret' }
  if (PRIVATE_QUERY.test(folded) || SENSITIVE_ALL.test(folded)) return { ok: false, reason: 'deny_word' }
  const words = factWords(folded)
  if (words.some(w => ctx.nameWords.has(w) || ctx.nameWords.has(stemWord(w)))) return { ok: false, reason: 'name' }
  const padded = ` ${words.map(stemWord).join(' ')} `
  if (ctx.terms.some(t => padded.includes(` ${t.join(' ')} `))) return { ok: false, reason: 'owner_term' }
  const grams = new Set<string>()
  for (let n = 1; n <= 2; n++) for (let i = 0; i + n <= words.length; i++) grams.add(stemWord(words.slice(i, i + n).join('')))
  if (ctx.joins.some(j => grams.has(stemWord(j)))) return { ok: false, reason: 'owner_term' }
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
