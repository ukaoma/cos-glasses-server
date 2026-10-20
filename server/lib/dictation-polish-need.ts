/**
 * Skip the polish model when the text has nothing for it to fix.
 *
 * Runs after the deterministic filler pass. The model is called only when one of these
 * is present; anything else goes out as the filler-passed text with polishSkipped "clean":
 * - a backtrack or self-correction marker ("actually", "no wait", "I mean", "scratch that", "sorry")
 * - a repeated word or stutter ("the the", "I I"), or a clause restarted on its first word
 *   ("we should, we need to")
 * - a filler-like the deterministic pass leaves to the model ("like", "you know", "kind of"),
 *   or a sentence that opens on a tic ("So", "Well", "Okay")
 * - a filler sound still present (a meeting line, or one the pass kept)
 * - spoken formatting or punctuation ("new line", "bullet point", "comma", "question mark")
 * - text that does not read as finished: no capital at the start or no closing punctuation
 * - more than MAX_WORDS words
 * Each check errs toward calling the model: a false "needed" costs a model call, a false
 * "clean" costs a fix. What it cannot see is a mis-heard name ("ask preeya" for Priya): the
 * 6.79.2 eval found those are the fixes skipping loses, so the switch defaults OFF.
 */
export const MAX_WORDS = 40

export type PolishNeed =
  | 'backtrack' | 'repeat' | 'false_start' | 'filler_like' | 'filler' | 'formatting' | 'unfinished' | 'long'

const BACKTRACK = /\b(actually|no,? wait|wait,? no|i mean|scratch that|sorry|or rather|correction|let me rephrase|i meant|no no)\b|,\s*no\s*,/i
const REPEAT = /(?<![\p{L}\p{N}'])([\p{L}\p{N}']+)[\s,]+\1(?![\p{L}\p{N}'])/iu
/** A clause restarted on the same word: "we should, we need to". */
const FALSE_START = /(?<![\p{L}\p{N}'])([\p{L}']+)\s+[\p{L}']+(?:\s+[\p{L}']+)?,\s+\1(?![\p{L}\p{N}'])/iu
const FILLER_LIKE = /\b(like|you know|kind of|kinda|sort of|sorta|basically|literally|i guess)\b|^["“(]?(so|well|okay|ok|alright|anyway)\b/i
const FILLER = /(?<![\p{L}\p{N}'’-])(um+|uhm|uh+|erm?|ah+|hm+|mm+|mhm)(?![\p{L}\p{N}'’-])/iu
const FORMATTING = /\b(new ?line|new paragraph|next line|bullet( point)?|numbered|number (one|two|three|1|2|3)|comma|period|full stop|question mark|exclamation (point|mark)|colon|semicolon|open (quote|paren)|close (quote|paren)|dash)\b/i

export function polishNeed(text: string): PolishNeed | null {
  const trimmed = text.trim()
  if (BACKTRACK.test(trimmed)) return 'backtrack'
  if (REPEAT.test(trimmed)) return 'repeat'
  if (FALSE_START.test(trimmed)) return 'false_start'
  if (FILLER_LIKE.test(trimmed)) return 'filler_like'
  if (FILLER.test(trimmed)) return 'filler'
  if (FORMATTING.test(trimmed)) return 'formatting'
  if (!/^["“'‘(]?[\p{Lu}\p{N}]/u.test(trimmed) || !/[.?!]["”’)]*$/.test(trimmed)) return 'unfinished'
  if (trimmed.split(/\s+/).length > MAX_WORDS) return 'long'
  return null
}

/** Off unless COS_DICTATION_POLISH_SKIP_CLEAN is 1, true or on. */
export function skipCleanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'on'].includes((env.COS_DICTATION_POLISH_SKIP_CLEAN ?? '').trim().toLowerCase())
}
