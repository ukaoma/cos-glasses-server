/**
 * 6.83.1: spoken paths and links in dictated messages. Miles, 2026-10-21, dictating funnel
 * pages: "demo, forward slash pricing, forward slash build and price". He meant /pricing and
 * /build-and-price, and COS gave him the words.
 *
 * Two pieces, both pure, both used by the outbound dictation pass in routes/prompt-drafts.ts:
 *
 * 1. renderSpokenPaths: the ONE case a rule can do safely. "forward slash" plus a single word
 *    that ends a phrase (a comma, a sentence end, a line end, or the end of the text) becomes
 *    "/word" in lowercase: "go to forward slash pricing." becomes "go to /pricing.". Anything
 *    longer ("forward slash build and price") is left to the polish model, which can tell
 *    where a slug ends; a rule cannot. Not rewritten:
 *    - "slash" without "forward": "and slash or", "slash prices" are ordinary speech.
 *    - the character itself: "the forward slash key", "a forward slash", "forward slash
 *      character" (an article before it, or a word that names the key after it).
 *    - ordinary speech after it: "with forward slash instead", "type forward slash twice"
 *      (an adverb or function word, NOT_A_SLUG).
 *    Off with COS_DICTATION_SPOKEN_PATHS=0. Meeting lines never come here (they stay faithful).
 *
 * 2. polishLinkProblem: a guard on the model's answer. The polish must never invent a link
 *    and must keep a link the dictionary already wrote. It returns why an answer is refused,
 *    or null. A refused answer means the caller sends the pre-polish text instead.
 */

import { HANDLE, LINK_TLDS } from './glossary-learn.js'

const ARTICLE_BEFORE = /(?:^|[^\p{L}\p{N}])(?:the|a|an|this|that|one)[ \t]+$/iu
/**
 * Words that follow "forward slash" in ordinary speech about the character, never a page name
 * (6.83.1 QA W1): "with forward slash instead", "type forward slash twice", "two forward slash
 * marks". The names of the key, singular and plural, adverbs, and common function words.
 */
export const NOT_A_SLUG = new Set([
  'key', 'keys', 'character', 'characters', 'char', 'chars', 'sign', 'signs', 'symbol', 'symbols', 'mark', 'marks', 'button', 'buttons',
  'instead', 'too', 'twice', 'once', 'again', 'everywhere', 'here', 'there', 'only', 'please', 'first', 'last', 'also', 'now', 'then',
  'either', 'neither', 'always', 'never', 'anywhere', 'somewhere', 'before', 'after', 'later', 'yet', 'still', 'though', 'anyway',
  'the', 'a', 'an', 'and', 'or', 'but', 'nor', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'if', 'not', 'no', 'yes', 'all', 'each', 'every', 'both',
  'more', 'less', 'one', 'two', 'three', 'thanks', 'ok', 'okay',
])
/** "forward slash" (or "forward-slash"), one word, then a phrase end. */
const SPOKEN_PATH = /(?<![\p{L}\p{N}])forward[ \t-]+slash[ \t]+([\p{L}\p{N}]+)(?=[ \t]*(?:[,.;:!?)]|\n|$))/giu

export function spokenPathsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'off'].includes((env.COS_DICTATION_SPOKEN_PATHS ?? '').trim().toLowerCase())
}

export function renderSpokenPaths(text: string): string {
  return text.replace(SPOKEN_PATH, (match: string, word: string, offset: number) => {
    if (NOT_A_SLUG.has(word.toLowerCase())) return match
    if (ARTICLE_BEFORE.test(text.slice(0, offset))) return match
    return `/${word.toLowerCase()}`
  })
}

/** A written link, email, domain, handle or path, as a polish answer might contain one. */
const LINK_TOKEN = new RegExp([
  String.raw`https?:\/\/[^\s<>"')\]]+`,
  String.raw`\bwww\.[^\s<>"')\]]+`,
  String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`,
  String.raw`\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:${LINK_TLDS.join('|')})\b(?:\/[^\s<>"')\]]*)?`,
  // A handle: "@sam", "@quilt_hq" (an email is matched whole above, first).
  HANDLE.source,
  // A path at the start of a token: "/pricing", "/build-and-price", "/docs/setup". Never
  // "and/or" or "10/21" (a letter or digit right before the slash).
  String.raw`(?<![\p{L}\p{N}\/])\/[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*`,
].join('|'), 'giu')

export function linkTokens(text: string): string[] {
  return (text.match(LINK_TOKEN) ?? []).map(token => token.replace(/[.,;:!?]+$/, ''))
}

const compact = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const spoken = (text: string, re: RegExp) => re.test(text)
/** An explicit request for paths: "as slugs", "as paths", "as a URL". Not any "path" ("the critical path"). */
const ASKS_FOR_PATHS = /\bas\s+(?:an?\s+)?(?:slugs?|paths?|urls?)\b/u
/** A dot spoken, or written between two letters ("docs.example"). "v6.83" or "3.5" is not one. */
const SPOKEN_DOT = /\bdot\b|\p{L}\.\p{L}/u

/**
 * Why a polish answer must not be sent, or null.
 * - 'invented_link': the answer holds a link, email, handle or path whose letters the speaker
 *   never said (a word from `knownSpellings`, the dictionary's vocabulary, counts as said, so a
 *   corrected spelling passes), or whose shape they never spoke: a path without "slash" (unless
 *   they asked for slugs, paths or a URL), a domain without "dot", an email or handle without
 *   "at". A scheme or "www" nobody said fails on its letters. A path made only of NOT_A_SLUG
 *   words ("/twice", "/everywhere") is the character talked about, not a page.
 * - 'lost_dictionary_link': the text going in held a link the dictionary wrote (a
 *   correction-only form such as "/pricing") and the answer dropped it, in any case.
 * Not handled: a number said as words and written as digits ("three sixty dot com" as
 * "360.com") reads as invented; the answer is refused and the pre-polish text goes out.
 */
export function polishLinkProblem(
  input: string,
  output: string,
  dictionaryLinks: readonly string[] = [],
  knownSpellings: readonly string[] = [],
): 'invented_link' | 'lost_dictionary_link' | null {
  const inputFold = input.toLowerCase(), outputFold = output.toLowerCase()
  for (const link of dictionaryLinks) {
    const l = link.toLowerCase()
    if (l && inputFold.includes(l) && !outputFold.includes(l)) return 'lost_dictionary_link'
  }
  const said = compact(input)
  const known = new Set(knownSpellings.map(compact).filter(Boolean))
  for (const token of linkTokens(output)) {
    const lower = token.toLowerCase()
    // Every letter run in the link must have been said somewhere (not necessarily in order).
    const pieces = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    if (pieces.some(piece => !said.includes(piece) && !known.has(piece))) return 'invented_link'
    // And its shape must have been spoken. A link already written in the input has its marks there.
    if (lower.includes('@') && !spoken(inputFold, /@|\bat\b/)) return 'invented_link'
    if (/\.[\p{L}]/u.test(lower.replace(/^https?:\/\//, '').split('@').pop() ?? '') && !spoken(inputFold, SPOKEN_DOT)) return 'invented_link'
    if (lower.startsWith('/') && !spoken(inputFold, /\bslash\b|(?<![\p{L}\p{N}])\/[\p{L}\p{N}]/u) && !spoken(inputFold, ASKS_FOR_PATHS)) return 'invented_link'
    // "/twice", "/everywhere": the speaker talked about the character, not a page (NOT_A_SLUG).
    if (lower.startsWith('/') && !lower.includes('.') && pieces.every(piece => NOT_A_SLUG.has(piece))) return 'invented_link'
  }
  return null
}
