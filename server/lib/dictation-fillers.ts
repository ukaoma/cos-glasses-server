/**
 * 6.79.1: a deterministic disfluency pass for dictated messages and prompt drafts.
 *
 * Runs before the polish model and on every path where the model is skipped (daily cap,
 * breaker open, too long, disabled), so "um" and "uh" never reach a sent message because a
 * budget ran out. Meeting text never comes here: a meeting transcript stays faithful.
 *
 * Removes standalone um, umm, uh, uhh, uhm, er, erm, ah, ahh, hmm, hm, mm, mhm (elongations
 * like "ummm" and "hmmm" too), any case, with the comma, ellipsis and spacing around them.
 * Deliberately left alone:
 * - ALL-CAPS tokens ("UM", "ER", "AH"): an acronym is more likely than a shouted filler.
 * - hyphenated or apostrophe forms ("Uh-oh", "uh-huh", "mm-hmm", "um's"): they carry meaning.
 * - words that merely contain the letters ("umbrella", "err", "ahead", "hmmingbird").
 * - "mm" after a number ("5 mm"): a unit.
 * - a capitalized token away from a sentence start ("Ask Ah Kow"): a name, unless a comma or
 *   ellipsis follows it ("I think, Um, we"). An abbreviation's period ("Mr.", "e.g.", "5 p.m.",
 *   "U.S.", an initial) and an ellipsis are not sentence ends, so they neither start a sentence
 *   nor trigger the capital hand-off.
 * - any token right after a title ("Mr. Ah", "Dr. Er") and any quoted mention ('"um"').
 * - "uh huh", "uh oh" and "mm hmm" written without a hyphen: answers, not hesitations.
 * - "like", "you know", "I mean": filler only sometimes, so the model decides, not a regex.
 * A filler inside a longer quote ("um, no") is removed like any other.
 * If nothing but fillers was said, the original text is returned unchanged.
 */

const FILLER = /(?<![\p{L}\p{N}'’-])(um+|uhm|uh+|erm?|ah+|hm+|mm+|mhm)(?![\p{L}\p{N}'’-])/giu
/** After a filler: a pause mark (comma, ellipsis, dash) with its spacing. */
const TRAILING_PAUSE = /^[ \t]*(?:,|\.{2,}|…|--|—|–)?[ \t]*/
/** A filler said as its own sentence ("Hmm. Let me think."): its terminator goes with it. */
const OWN_SENTENCE_END = /^[ \t]*[.?!]+[ \t]*/
const CLOSES_CLAUSE = /^(?:[.?!;:)\]}"”’]|$|\n)/

/** A period that ends an abbreviation, not a sentence: "Mr.", "e.g.", "5 p.m.", "U.S.", "J.". */
const ABBREVIATION = /(?:^|[\s(“"‘'])(?:mrs?|ms|dr|prof|st|vs|etc|e\.g|i\.e|a\.m|p\.m|u\.s)\.["”’)]*$/i
const INITIAL = /(?:^|[\s(“"‘'])[A-Z]\.["”’)]*$/
/** A title right before a token makes the token a name ("Mr. Ah", "Dr. Er"). */
const TITLE = /(?:^|[\s(“"‘'])(?:mrs?|ms|dr|prof|st)\.[ \t]*$/i
const QUOTE_OPEN = /["“”'‘’]$/
const QUOTE_CLOSE = /^["“”'‘’]/
/** A pause mark right after the token: a Titlecase filler set off this way is a hesitation. */
const PAUSE_AFTER = /^[ \t]*(?:,|\.{2,}|…)/

function sentenceStart(before: string): boolean {
  const trimmed = before.replace(/[ \t]+$/, '')
  if (trimmed === '' || trimmed.endsWith('\n')) return true
  if (!/[.?!]["”’)]*$/.test(trimmed)) return false
  // An ellipsis is a pause, and an abbreviation's period is not a sentence end.
  if (/(?:\.{2,}|…)["”’)]*$/.test(trimmed)) return false
  return !(ABBREVIATION.test(trimmed) || INITIAL.test(trimmed))
}

export function fillerPassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'off'].includes((env.COS_DICTATION_FILLER_PASS ?? '').trim().toLowerCase())
}

export function stripDisfluencies(text: string): string {
  let out = ''
  let rest = text
  let removed = false
  for (;;) {
    FILLER.lastIndex = 0
    const match = FILLER.exec(rest)
    if (!match) break
    const token = match[0]
    let before = rest.slice(0, match.index)
    let after = rest.slice(match.index + token.length)
    const atStart = sentenceStart(out + before)
    const keep = (token.length > 1 && token === token.toUpperCase())
      || (/^mm+$/i.test(token) && /\d[ \t]*$/.test(out + before))
      // A capital away from a sentence start is a name ("Ask Ah Kow"), unless a pause mark
      // sets it off as a hesitation ("I think, Um, we should").
      || (!atStart && /^[A-Z]/.test(token) && !PAUSE_AFTER.test(after))
      // Right after a title it is a name ("Mr. Ah", "Dr. Er").
      || TITLE.test(out + before)
      // A quoted mention is the word itself ('"um" is a filler word').
      || (QUOTE_OPEN.test(out + before) && QUOTE_CLOSE.test(after))
      // Two-word answers said without a hyphen: "uh huh", "uh oh", "mm hmm".
      || (/^uh$/i.test(token) && /^[ \t]+(huh|oh)(?![\p{L}\p{N}'’-])/iu.test(after))
      || (/^mm$/i.test(token) && /^[ \t]+hm+(?![\p{L}\p{N}'’-])/iu.test(after))
      || (/^hm+$/i.test(token) && /(?<![\p{L}\p{N}'’-])mm[ \t]+$/iu.test(out + before))
    if (keep) {
      out += before + token
      rest = after
      continue
    }
    removed = true
    const spaceBefore = /[ \t]$/.test(before) || (before === '' && /[ \t]$/.test(out))
    after = atStart && OWN_SENTENCE_END.test(after)
      ? after.replace(OWN_SENTENCE_END, '')
      : after.replace(TRAILING_PAUSE, '')
    before = before.replace(/[ \t]+$/, '')
    if (before === '') out = out.replace(/[ \t]+$/, '')
    if (CLOSES_CLAUSE.test(after)) {
      // "I think, uh." -> "I think." The pause mark before the filler belongs to it.
      before = before.replace(/[ \t]*[,;]$/, '')
      if (before === '') out = out.replace(/[ \t]*[,;]$/, '')
    }
    out += before
    if (atStart && /^[A-Z]/.test(token) && after) {
      // The filler carried the sentence's capital letter; hand it to the next word.
      after = after.replace(/^(["“'‘(]?)(\p{Ll})/u, (_m, open: string, ch: string) => open + ch.toUpperCase())
    }
    if (out !== '' && spaceBefore && after !== '' && !/^[\s.,?!;:)\]}"”’]/.test(after) && !/\s$/.test(out)) out += ' '
    rest = after
  }
  if (!removed) return text
  const result = (out + rest).replace(/^[ \t]*[,;][ \t]*/, '')
  return result.trim() === '' ? text : result
}
