/**
 * What may leave this Mac about a session, and in what shape (the "find" route, Control 0.5.362).
 *
 * Every string a decision model sees, and every string the route hands back as `judged_text`, goes through
 * `redactForModel`: READ a bounded window, REDACT it, then CUT. The order is the point. The list titles a session by
 * cutting its first line at 80 characters BEFORE any redaction, so a key that straddles the cut leaves its first half
 * unmasked (validated 2026-11-01: `OPENAI_API_KEY=abc123` cut after `abc` is no longer a recognizable pair). Here the
 * pair is masked whole while the window still holds all of it, and only then does the cut fall.
 *
 * Steps, in order:
 *   1. Read: lone surrogates, control and bidi characters out, NFKC (a full-width `ｊｏｈｎ＠ｅｘ…` becomes a plain address
 *      the next steps can see), one line, the first SCAN code points.
 *   2. This module's own rules for what mask does not know: phone numbers, card numbers, US social security numbers, short
 *      `pk_` and `rk_` keys, base64 that carries `+` or `/` (first, because mask's long-run rule stops at a `/` and would leave
 *      the tail of a run), and a credential word in a few other languages.
 *   3. SetupAssistant.mask, ported: key shapes, then `key: value` and `"key": "value"` pairs whose key names a credential,
 *      then long opaque runs. Control masks the same way before it draws a hit, so both sides agree on what a key is.
 *   4. work-search's `searchOptionText`: the server's secret redaction, markdown links to their label, URLs, email
 *      addresses and opaque ids out. Its own slice at 300 UTF-16 units never comes into play for the 150 code points a
 *      session gets; a 200 code point query made of astral characters may be cut earlier, which is safe and well formed.
 *   5. Cut by code points (an emoji is one, so a surrogate pair is never split). If the cut falls inside an unbroken
 *      ASCII token, that token is dropped: the half of a key that survives a cut is the half nobody masked.
 *
 * This is not anonymization. Names, street addresses and ordinary prose go through, and the consent line says so.
 */
import { searchOptionText, WORK_SEARCH_LIMITS } from './work-search.js'

export const FIND_TITLE_CHARS = 90
export const FIND_PROMPT_CHARS = 150
export const FIND_QUERY_CHARS = 200
/** Code points read before redacting: seven times the longest cut, so a pair or a block that starts inside a cut is whole. */
export const FIND_SCAN_CHARS = 1_000
/** Input bound before anything is normalized, so a pathological caller cannot make NFKC or the scan expensive. */
const INPUT_UNITS = 8_000
export const HIDDEN = '[hidden]'

const keyShapes: RegExp[] = [
  /(?<![A-Za-z0-9])(?:sk|sess)-[A-Za-z0-9_\-]{16,}/g,
  /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}|(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{16,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_\-]{16,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9\-]{10,}/g,
  /hooks\.slack\.com\/services\/[A-Za-z0-9/_\-]+/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{12,}/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}/g,
  /(?<![A-Za-z0-9])bearer\s+[A-Za-z0-9._~+/\-]{16,}=*/gi,
  /authorization["']?\s*[:=]\s*["']?basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
  /(?<![A-Za-z0-9])basic\s+[A-Za-z0-9+/]{16,}={1,2}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]*(?:-----END [A-Z ]*PRIVATE KEY-----)?/g,
  /[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^/\s:@'"]+:[^/\s@'"]+@/g,
  /(?<![A-Za-z0-9])--(?:password|passwd|token|secret|api[_-]?key)(?:=|\s+)\S{4,}/gi,
]
const pairKeyShape = /(?<![A-Za-z0-9])(["']?)([A-Za-z_][A-Za-z0-9_.\-]*)\1[ \t]*[:=][ \t]*/g
const pairValueShape = /^(?:"[^"\\]{4,}"|'[^'\\]{4,}'|[^\s"',;]{6,})/
const longRunShape = /(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{32,}(?![A-Za-z0-9_\-])/g

/** A key that names a credential: it holds PASSWORD or PASSWD, or ends in a credential word. A copy of SetupAssistant.credentialKey. */
export function credentialKey(key: string): boolean {
  let snake = ''
  let previous = ''
  for (const ch of key) {
    if (/[A-Z]/.test(ch) && previous && (/[a-z]/.test(previous) || /[0-9]/.test(previous))) snake += '_'
    snake += ch
    previous = ch
  }
  const upper = snake.toUpperCase().replace(/-/g, '_').replace(/\./g, '_')
  if (upper.includes('PASSWORD') || upper.includes('PASSWD')) return true
  const words = ['PASS', 'SECRET', 'TOKEN', 'APIKEY', 'API_KEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'ACCESS_KEY_ID', 'SECRET_KEY', 'AUTH_KEY', 'CREDENTIALS']
  return words.some(word => upper === word || upper.endsWith('_' + word))
}

/** A name, not a key: a UUID, a name that carries one, or a plan or file name of words joined by underscores or hyphens. */
function readsAsName(run: string): boolean {
  const rest = run.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '')
  const segments = rest.split(/[_-]/).filter(Boolean)
  if (rest.length < run.length && segments.every(s => /^\p{L}+$/u.test(s))) return true
  const humps = (word: string) => { let count = 0, previous = ''; for (const ch of word) { if (/[A-Z]/.test(ch) && previous && /[a-z]/.test(previous)) count++; previous = ch } return count }
  return segments.filter(s => s.length >= 4 && /^\p{L}+$/u.test(s) && humps(s) <= 1).length >= 2
}

/** Port of SetupAssistant.mask (Control, Sources/SetupAssistant.swift). Tests pin it to the same fake secrets. */
export function maskKeyShapes(text: string): string {
  let out = text
  for (const re of keyShapes) out = out.replace(new RegExp(re.source, re.flags), HIDDEN)
  // Credential pairs: found on the string as it stands, then the ranges are hidden together (as the Swift does).
  const hide: Array<[number, number]> = []
  let resume = 0
  for (const match of out.matchAll(new RegExp(pairKeyShape.source, 'g'))) {
    const start = match.index!, end = start + match[0].length
    if (start < resume) continue
    const key = match[2]!
    if (!credentialKey(key)) continue
    const value = pairValueShape.exec(out.slice(end))
    if (!value) continue
    // A bare "pass" is a word as often as a password ("First pass: reviewed"): it hides only a value with a digit in it.
    if (key.toLowerCase() === 'pass' && !/[0-9]/.test(value[0])) continue
    hide.push([start, end + value[0].length])
    resume = end + value[0].length
  }
  let result = '', cursor = 0
  for (const [from, to] of hide) { result += out.slice(cursor, from) + HIDDEN; cursor = to }
  out = result + out.slice(cursor)
  return out.replace(new RegExp(longRunShape.source, 'g'), run => (/\p{L}/u.test(run) && /[0-9]/.test(run) && !readsAsName(run)) ? HIDDEN : run)
}

// What mask does not know. Each is broad on purpose: a number or a code wrongly hidden costs a little search signal, and one
// left in goes to a third party.
const PHONE_NANP = /(?<![\d])(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/g
const PHONE_INTERNATIONAL = /(?<![\d\w])\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?(?:[\s.\-]?\d{2,4}){2,4}(?!\d)/g
const CARD_NUMBER = /(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)/g
const SSN = /(?<!\d)\d{3}[\- ]\d{2}[\- ]\d{4}(?!\d)/g
const SSN_LABELLED = /\b(?:ssn|social security(?: number)?)\D{0,16}\d{9}(?!\d)/gi
const SHORT_STRIPE_KEY = /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g
const BASE64_RUN = /(?<![A-Za-z0-9+/_\-])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/])/g
// A credential word in other languages, with its value: "contraseña: Clave9876", "Passwort = Geheim1234".
const FOREIGN_CREDENTIAL = /(?<![\p{L}\p{N}])(?:contrase[ñn]a|mot de passe|passwort|kennwort|senha|palavra-passe|wachtwoord|lösenord|hasło|пароль|密码|パスワード|비밀번호)[ \t]*[:=：][ \t]*\S{4,}/giu

// A pair whose key ends in KEY, which mask's credentialKey list (API_KEY, ACCESS_KEY, SECRET_KEY...) does not: STRIPE_KEY=, OPENAI_KEY=,
// AccountKey=, license-key:, and the spoken forms "api key:" and "secret key=". A bare "key: value" is a YAML word as often as a
// secret, so it hides only a value of 8 or more characters that has a digit in it. "monkey=" and "hotkey" end in the letters but not
// at a word boundary, so they are left alone.
// PARITY: these rules, the unicode address rule and the invisible-character strip are THIS module's. Control's SetupAssistant.mask does
// not have them, which is safe (Control masks only what it draws; this decides what leaves the Mac). Do not add them to the Swift
// pin (`SWIFT_MASK` below tests maskKeyShapes alone).
const KEY_VALUE = String.raw`(?:"[^"\\]{4,}"|'[^'\\]{4,}'|[^\s"',;]{6,})`
const KEY_PAIR = new RegExp(String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9_.\-]*[_.\-](?:key|KEY|Key)|[A-Za-z0-9_.\-]*(?<=[a-z0-9])Key)["']?[ \t]*[:=][ \t]*${KEY_VALUE}`, 'g')
const SPOKEN_KEY_PAIR = new RegExp(String.raw`(?<![A-Za-z0-9])(?:api|secret|access|private|auth|account|license|licence|encryption|signing)[ ]key["']?[ \t]*[:=][ \t]*${KEY_VALUE}`, 'gi')
const BARE_KEY_PAIR = /(?<![A-Za-z0-9_.\-])(?:key|KEY|Key)[ \t]*[:=][ \t]*(?=[^\s"',;]*\d)[^\s"',;]{8,}/g
// An address with letters outside ASCII (josé@example.com); the server's own rule is ASCII only.
const UNICODE_EMAIL = /[\p{L}\p{N}._%+\-]{1,64}@[\p{L}\p{N}.\-]{1,253}\.\p{L}{2,24}/gu

export function maskMore(text: string): string {
  // An address goes out as a space, as searchOptionText does, so a query that is only an address is left empty.
  let out = text.replace(UNICODE_EMAIL, ' ')
  for (const re of [KEY_PAIR, SPOKEN_KEY_PAIR, BARE_KEY_PAIR, FOREIGN_CREDENTIAL, SHORT_STRIPE_KEY, SSN_LABELLED, SSN, CARD_NUMBER, PHONE_INTERNATIONAL, PHONE_NANP]) out = out.replace(re, HIDDEN)
  // Base64 that carries + or /, and the padded or long kind: mixed case with a digit, so a path or a word is left alone.
  return out.replace(BASE64_RUN, run => (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && (/[+/=]/.test(run) || run.length >= 40)) ? HIDDEN : run)
}

/** Lone surrogates, control and bidi characters out, NFKC, one line. */
function readableLine(raw: string): string {
  const wellFormed = raw.slice(0, INPUT_UNITS).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  return wellFormed.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim()
}

const TOKEN_CHAR = /[A-Za-z0-9_\-+/=.:@%]/

/**
 * At most `max` code points. When the cut falls inside an unbroken ASCII token (the last kept character and the next one
 * both belong to it), the kept part of that token is dropped too: half a key is the half nobody masked. Text in a script that
 * does not use spaces has no such token and is cut where it falls. `cutEarlier` says an earlier step already cut the text.
 */
export function cutAtCodePoints(text: string, max: number, cutEarlier = false): string {
  const points = Array.from(text)
  if (points.length <= max && !cutEarlier) return text
  const kept = points.slice(0, max)
  const next = points[max]
  const inside = cutEarlier ? true : next !== undefined && TOKEN_CHAR.test(next) && kept.length > 0 && TOKEN_CHAR.test(kept[kept.length - 1]!)
  if (inside) while (kept.length > 0 && TOKEN_CHAR.test(kept[kept.length - 1]!)) kept.pop()
  return kept.join('').trim()
}

/**
 * Read, redact, then cut. Returns one clean line of at most `max` code points, possibly empty. `cutUpstream` says the text was already
 * cut by whoever made it (the list cuts a first line at 80 and a title at 120, before any redaction), so its last token may be half a key.
 */
export function redactForModel(raw: string, max: number, cutUpstream = false): string {
  if (typeof raw !== 'string' || !raw) return ''
  const scan = cutAtCodePoints(readableLine(raw), FIND_SCAN_CHARS)
  const redacted = searchOptionText(maskKeyShapes(maskMore(scan)))
  // searchOptionText slices at its own 300 UTF-16 units; if it reached them it may have cut inside a token.
  return cutAtCodePoints(redacted, max, cutUpstream || redacted.length >= WORK_SEARCH_LIMITS.optionChars)
}

/** The search words as they leave: redacted like everything else, at most 200 code points. */
export function redactQuery(query: string): string { return redactForModel(query, FIND_QUERY_CHARS) }

export interface CandidateTexts {
  /** What the model reads for this session: the title and the first prompt, or the prompt alone when it begins with the title. */
  option: string
  /** The first-prompt part, redacted and cut. This is `judged_text` on the wire. */
  prompt: string
}

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * One session as the model sees it (the canary's shape B: 19 of 20 in the top three against 15 for the title alone):
 * `title: first prompt`. The list titles a session by the first line of its first prompt, and then the title is the start
 * of the prompt, so the prompt alone says it and a second copy of the words would only cost tokens.
 */
export function candidateTexts(title: string, typed: string): CandidateTexts {
  const t = redactForModel(title, FIND_TITLE_CHARS, title.length === 80 || title.length === 120)
  const prompt = redactForModel(typed, FIND_PROMPT_CHARS)
  if (!prompt) return { option: t, prompt: '' }
  const titleWords = norm(t)
  if (!titleWords || (titleWords.length >= 12 && norm(prompt).startsWith(titleWords.slice(0, 30)))) return { option: prompt, prompt }
  return { option: `${t}: ${prompt}`, prompt }
}
