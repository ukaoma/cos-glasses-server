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
/** A trailing * is a stem ("pregnan*" is pregnant, pregnancy); any other regex fragment ("doctors?") is used as written, and must
 *  not end in a bare * (write (?:\\w*)). Whole
 *  words only, so "son" never matches "reason". Run on normalizeForMatch text. */
const wordsRe = (words: string[]): RegExp => new RegExp(`\\b(?:${words.map(w => w.endsWith('*') ? `${w.slice(0, -1)}\\w*` : w).join('|')})\\b`, 'i')
export type SensitiveCategory = 'health' | 'family' | 'finance' | 'legal' | 'school' | 'funeral'
const CATEGORIES: readonly SensitiveCategory[] = ['health', 'family', 'finance', 'legal', 'school', 'funeral']

/** TWO LAYERS, because they have opposite costs. A window that is skipped loses a chance at a cue; a query that is let through
 *  can reach the web. So the WINDOW list holds only what is clearly personal (measured on the 974 saved windows: the broad list
 *  skipped 37.6% of them, mostly on ordinary work talk: court, sick, baby, finance, taxes, health, school, family, medical),
 *  and the QUERY list is the window list plus everything broader.
 *
 *  WINDOW_TERMS: family relations, health specifics, personal-finance phrases, legal specifics, school for kids, and death. */
const WINDOW_TERMS: Record<SensitiveCategory, string[]> = {
  health: ['doctors?', 'hospitals?', 'clinics?', 'diagnos*', 'chemo*', 'cancer', 'surger(?:y|ies)', 'therapists?', 'therapy', 'psychiatr*', 'psycholog*', 'prescription*',
    'pregnan*', 'icu', 'intensive care', 'emergency room', 'er visit', 'urgent care', 'ob gyn', 'obgyn', 'c section', 'csection', 'adhd', 'autis*', 'hospice'],
  family: ['wife', 'wives', 'husbands?', 'spouses?', 'kids?', 'moms?', 'mommy', 'dads?', 'daddy', 'sons?', 'daughters?', 'brothers?', 'sisters?', 'parents',
    'step ?(?:son|daughter|mom|dad|kid\\w*)', 'grandma*', 'grandpa*', 'grandmother*', 'grandfather*', 'grandchild*', 'grandson*', 'granddaughter*',
    'grandkid*', 'nephews?', 'nieces?'],
  finance: ['irs', 'tax bills?', 'tax returns?', 'back taxes', 'income tax(?:es)?', 'property tax(?:es)?', 'debts?', 'loans?', 'mortgages?', 'bankrupt*', 'credit score',
    'installment*', 'escrow', 'pensions?', 'roth', 'ira', 'rollover', 'k 1', 'alimony', 'child support'],
  legal: ['lawsuits?', 'sued', 'attorneys?', 'lawyers?', 'custody', 'divorce*', 'court dates?', 'court hearings?'],
  school: ['daycare*', 'preschool*', 'kindergarten*', 'school pick ?up', 'report cards?', 'tuition', 'parent teacher', 'dnp', 'dissertation*'],
  funeral: ['died', 'deaths?', 'funeral*', 'passed away', 'dying'],
}
/** DENY_EXTRA_TERMS: the broader words a QUERY must not carry. Bare words like these are common in work talk, so they never skip a
 *  window, but a web query is a different matter. Stems stop where a longer word would be a public topic: no "mom*" (moment),
 *  "kid*" (kidney), "tax*" (taxi, taxonomy), "grand*" (Grand Prix) or "mother*" (motherboard). */
const DENY_EXTRA_TERMS: Record<SensitiveCategory, string[]> = {
  health: ['health*', 'medical', 'medicine*', 'medication*', 'doctor*', 'hospital*', 'clinic*', 'therap*', 'surger*', 'pharmac*', 'oncolog*', 'illness*', 'symptom*',
    'dentist*', 'nurse', 'nurses', 'nursing', 'sick', 'injur*', 'anxiety', 'depress*', 'pediatric*', 'miscarriage*', 'infertil*', 'ivf'],
  family: ['family', 'families', 'husband*', 'spouse*', 'daughter*', 'brother*', 'sister*', 'kiddo', 'kiddos', 'child', 'children', 'childcare', 'childhood', 'baby',
    'babies', 'newborn', 'mum', 'mums', 'mother', 'mothers', 'motherhood', 'father', 'fathers', 'fatherhood', 'parent*', 'sibling*', 'aunt*', 'uncle*', 'cousin*',
    'fiance*', 'girlfriend', 'boyfriend', 'in laws', 'inlaws', 'birthday*', 'wedding*', 'step ?(?:mom|mother|dad|father|son|daughter|kid|child|brother|sister|parent|family)(?:\\w*)'],
  finance: ['financ*', 'tax', 'taxes', 'taxed', 'taxing', 'taxable', 'taxation', 'debt*', 'loan*', 'mortgage*', 'pension*', 'insurance', 'salary', 'salaries', 'payroll',
    'paycheck*', 'retirement', '401k', '403b', 'inheritance', 'net worth', 'k one'],
  legal: ['legal*', 'lawsuit*', 'sue', 'suing', 'lawyer*', 'attorney*', 'court', 'courts', 'courtroom*', 'subpoena*', 'settlement*', 'litigation'],
  school: ['school*', 'nursery', 'pre k', 'prek', 'teacher*', 'homework', 'doctoral'],
  funeral: ['obituar*', 'burial*', 'cemetery', 'die', 'dies', 'death*', 'grief', 'mourning', 'casket', 'condolence*'],
}
const WINDOW: ReadonlyArray<readonly [SensitiveCategory, RegExp]> = CATEGORIES.map(c => [c, wordsRe(WINDOW_TERMS[c])] as const)
const DENY_ALL = wordsRe(CATEGORIES.flatMap(c => [...WINDOW_TERMS[c], ...DENY_EXTRA_TERMS[c]]))

/** The clearly personal category a transcript window touches, or null. Pure and exported so the saved windows can be replayed
 *  through it. Private-life vocabulary only, and only the high-precision list: the owner's profile terms never skip a window
 *  (measured: whole-term matching still skipped a third of the work windows that pass the trigger, word matching all of them),
 *  and neither do bare words like court, sick, baby, finance, taxes, health, school, family or medical. The broad list guards the
 *  QUERY instead (denyWordHit, ownerTermPhrases). */
export function sensitiveWindow(text: string): SensitiveCategory | null {
  const t = normalizeForMatch(text)
  for (const [category, re] of WINDOW) if (re.test(t)) return category
  return null
}
/** Runs of two or more consecutive tokens of one or two letters, joined ("i r s" is irs, "ta x" is tax): a query spelled out letter
 *  by letter is the word it spells. Appended to the text before the deny list reads it, so nothing already in it is lost. */
function collapseShortRuns(folded: string): string {
  const out: string[] = []
  let run: string[] = []
  const flush = () => { if (run.length >= 2 && run.join('').length >= 3) out.push(run.join('')); run = [] }
  for (const token of folded.split(' ')) { if (/^\p{L}{1,2}$/u.test(token)) run.push(token); else flush() }
  flush()
  return out.join(' ')
}
/** Does a QUERY (or any text) carry a word of the broad deny list? The window list plus the broader words, the Ask gate's private
 *  words, and the letter-by-letter spellings of them. Pure and exported for probes. */
export function denyWordHit(text: string): boolean {
  const folded = normalizeForMatch(text)
  const spelled = `${folded} ${collapseShortRuns(folded)}`
  return PRIVATE_QUERY.test(spelled) || DENY_ALL.test(spelled)
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
  if (denyWordHit(folded)) return { ok: false, reason: 'deny_word' }
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
