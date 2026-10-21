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
 *    Off with COS_DICTATION_SPOKEN_PATHS=0. Meeting lines never come here (they stay faithful).
 *
 * 2. polishLinkProblem: a guard on the model's answer. The polish must never invent a link
 *    and must keep a link the dictionary already wrote. It returns why an answer is refused,
 *    or null. A refused answer means the caller sends the pre-polish text instead.
 */

const ARTICLE_BEFORE = /(?:^|[^\p{L}\p{N}])(?:the|a|an|this|that|one)[ \t]+$/iu
const NAMES_THE_KEY = /^(?:key|character|char|sign|symbol|mark|button)$/i
/** "forward slash" (or "forward-slash"), one word, then a phrase end. */
const SPOKEN_PATH = /(?<![\p{L}\p{N}])forward[ \t-]+slash[ \t]+([\p{L}\p{N}]+)(?=[ \t]*(?:[,.;:!?)]|\n|$))/giu

export function spokenPathsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'off'].includes((env.COS_DICTATION_SPOKEN_PATHS ?? '').trim().toLowerCase())
}

export function renderSpokenPaths(text: string): string {
  return text.replace(SPOKEN_PATH, (match: string, word: string, offset: number) => {
    if (NAMES_THE_KEY.test(word)) return match
    if (ARTICLE_BEFORE.test(text.slice(0, offset))) return match
    return `/${word.toLowerCase()}`
  })
}

/** A written link, email, domain or path, as a polish answer might contain one. */
const LINK_TOKEN = new RegExp([
  String.raw`https?:\/\/[^\s<>"')\]]+`,
  String.raw`\bwww\.[^\s<>"')\]]+`,
  String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`,
  String.raw`\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|io|ai|co|gov|edu|app|dev|us|uk)\b(?:\/[^\s<>"')\]]*)?`,
  // A path at the start of a token: "/pricing", "/build-and-price", "/docs/setup". Never
  // "and/or" or "10/21" (a letter or digit right before the slash).
  String.raw`(?<![\p{L}\p{N}\/])\/[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*`,
].join('|'), 'giu')

export function linkTokens(text: string): string[] {
  return (text.match(LINK_TOKEN) ?? []).map(token => token.replace(/[.,;:!?]+$/, ''))
}

const compact = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const spoken = (text: string, re: RegExp) => re.test(text)

/**
 * Why a polish answer must not be sent, or null.
 * - 'invented_link': the answer holds a link, email or path whose letters the speaker never
 *   said, or whose shape they never spoke (a path without "slash", a domain without "dot",
 *   an email without "at"; a scheme or "www" nobody said fails on its letters).
 * - 'lost_dictionary_link': the text going in held a link the dictionary wrote (a
 *   correction-only form such as "/pricing") and the answer dropped it.
 */
export function polishLinkProblem(input: string, output: string, dictionaryLinks: readonly string[] = []): 'invented_link' | 'lost_dictionary_link' | null {
  for (const link of dictionaryLinks) {
    if (link && input.includes(link) && !output.includes(link)) return 'lost_dictionary_link'
  }
  const said = compact(input)
  const inputLower = input.toLowerCase()
  for (const token of linkTokens(output)) {
    const lower = token.toLowerCase()
    // A link already written in the input passes the checks below on its own letters and marks.
    // Every letter run in the link must have been said, in order, somewhere.
    const pieces = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    if (pieces.some(piece => !said.includes(piece))) return 'invented_link'
    // And its shape must have been spoken.
    // A scheme or "www" nobody said already fails the letters check above ("https", "www").
    if (lower.includes('@') && !spoken(inputLower, /@|\bat\b/)) return 'invented_link'
    // A sentence's period or "and/or" is not a spoken dot or slash: only "dot", "slash", or
    // the mark already inside a written token counts.
    if (/\.[\p{L}]/u.test(lower.replace(/^https?:\/\//, '').split('@').pop() ?? '') && !spoken(inputLower, /\bdot\b|[\p{L}\p{N}]\.[\p{L}\p{N}]/u)) return 'invented_link'
    // "format these as slugs" asks for paths without saying "slash".
    if (lower.startsWith('/') && !spoken(inputLower, /\bslash\b|(?<![\p{L}\p{N}])\/[\p{L}\p{N}]|\b(?:slugs?|paths?|urls?)\b/u)) return 'invented_link'
  }
  return null
}
