import { readSwitch } from './env-switch.js'

/**
 * 6.91.0: the register a dictation is written in, chosen from the app it is going to.
 *
 * COS Control has sent the frontmost app's localized name as `context.app` on every Mac polish
 * since 0.5.325; until 6.91.0 the server ignored it. The MVP has two registers (plan r2):
 *
 * - literal: terminals (iTerm2, Terminal, Ghostty, Warp, WezTerm, Alacritty, kitty). The model
 *   adds no sentence capital, no trailing period and no learned style, and keeps the speaker's
 *   words (self-corrections and spoken paths included); a deterministic check then requires the
 *   answer's words to equal its input's apart from fillers, stutters, punctuation and case, and
 *   falls back to the input otherwise (finalize `guard: "literal"`).
 * - default: everything else, Claude, Cursor and Codex included, and an unknown, blank or
 *   malformed app name. G2 messages (no app) and meeting lines are default too.
 *
 * ONE table, matched on the exact name (case and surrounding space ignored), published to Control
 * by GET /api/dictation/learned-style (`registers`) so Control never keeps a second copy. The app
 * name is read here, never logged, audited or echoed. COS_DICTATION_REGISTERS=0 makes every app
 * default, so the prompt carries no register block at all.
 */
export type DictationRegister = 'literal' | 'default'
export const DICTATION_REGISTERS: readonly DictationRegister[] = ['literal', 'default']

export const LITERAL_APPS: readonly string[] = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'WezTerm', 'Alacritty', 'kitty']

const LITERAL = new Set(LITERAL_APPS.map(app => app.toLowerCase()))

export function registersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_DICTATION_REGISTERS, true)
}

/**
 * The register for a frontmost-app name: an exact table match (case and surrounding space ignored)
 * or `default`. A long, multi-line or non-string value can never match the table, so it is default
 * without a separate check (the 6.91.0 mutation gate showed one was unreachable).
 */
export function registerForApp(app: unknown, env: NodeJS.ProcessEnv = process.env): DictationRegister {
  if (!registersEnabled(env) || typeof app !== 'string') return 'default'
  return LITERAL.has(app.trim().toLowerCase()) ? 'literal' : 'default'
}

/** `context.app` from a finalize body, without trusting its shape (a primitive or array has no `app`). */
export function registerFromContext(context: unknown, env: NodeJS.ProcessEnv = process.env): DictationRegister {
  return registerForApp((context as { app?: unknown } | null | undefined)?.app, env)
}

/** What GET /api/dictation/learned-style publishes: every app that is not default. Empty when switched off. */
export function publishedRegisters(env: NodeJS.ProcessEnv = process.env): Record<string, 'literal'> {
  return registersEnabled(env) ? Object.fromEntries(LITERAL_APPS.map(app => [app, 'literal' as const])) : {}
}

/** Verbal tics the literal check lets the model drop (one word or two). Never a negation or number. */
const LITERAL_DROPPABLE = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm',
  'like', 'basically', 'so', 'well'])
const LITERAL_DROPPABLE_PAIRS = new Set(['you know', 'i mean', 'kind of', 'sort of'])

interface Word { lower: string; start: number; end: number }
function words(text: string): Word[] {
  const out: Word[] = []
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ lower: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length })
  return out
}

/** The words that carry the text: fillers out, a stutter ("the the") collapsed. */
function core(list: Word[]): Word[] {
  const out: Word[] = []
  for (let i = 0; i < list.length; i++) {
    const pair = i + 1 < list.length ? `${list[i].lower} ${list[i + 1].lower}` : ''
    if (pair && LITERAL_DROPPABLE_PAIRS.has(pair)) { i++; continue }
    if (LITERAL_DROPPABLE.has(list[i].lower)) continue
    if (out.length && out[out.length - 1].lower === list[i].lower) continue
    out.push(list[i])
  }
  return out
}

/**
 * The literal register's deterministic check and repair. Pure.
 *
 * `null` when the answer changed a word (beyond fillers, stutters, punctuation and case): the
 * caller sends the input instead. Otherwise the answer with the input's own casing put back on
 * every word, and without a trailing period the input did not have, so a terminal gets no added
 * capital and no added period whatever the model did.
 */
export function literalAnswer(input: string, answer: string): string | null {
  const a = core(words(answer))
  const b = core(words(input))
  if (a.length !== b.length || a.some((w, i) => w.lower !== b[i].lower)) return null
  const inputWords = words(input)
  const original = new Map<string, string[]>()
  for (const w of inputWords) original.set(w.lower, [...(original.get(w.lower) ?? []), input.slice(w.start, w.end)])
  let out = ''
  let last = 0
  const seen = new Map<string, number>()
  for (const w of words(answer)) {
    const forms = original.get(w.lower)
    const k = seen.get(w.lower) ?? 0
    seen.set(w.lower, k + 1)
    out += answer.slice(last, w.start) + (forms ? forms[Math.min(k, forms.length - 1)] : answer.slice(w.start, w.end))
    last = w.end
  }
  out += answer.slice(last)
  if (/\.\s*$/.test(out) && !/\.\s*$/.test(input)) out = out.replace(/\.(\s*)$/, '$1')
  return out.trim()
}
