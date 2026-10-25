import { createHash } from 'node:crypto'
import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { readSwitch } from './env-switch.js'
import type { DictationRegister } from './dictation-register.js'

/**
 * 6.91.0: "Your style", the learned-style setting (plan r2, contract frozen 2026-10-24).
 *
 * COS Control derives style rules from the corrections the person types into their own dictation
 * (a deterministic diff on the Mac, no LLM) and stores the active ones here, so Mac dictation and
 * G2 messages both get them. The same pattern as the 6.85.0 polish instructions, with its own file,
 * cap and switch, and one difference that matters: the client sends CODES, never text. A rule is
 * a `kind` plus a `param` from a closed set, and the server renders the words the model reads
 * from its own templates, so no client string ever reaches the prompt.
 *
 * - kinds: `drop_phrase` (param from LEARNED_STYLE_ALLOWLIST) and `contractions` (use | avoid).
 * - register: `all` only in the MVP. A literal target (a terminal) never gets learned style.
 * - At most LEARNED_STYLE_MAX_RULES rules, rendered to at most LEARNED_STYLE_MAX_CHARS. Over either
 *   is refused (413), never silently dropped or turned off.
 * - The server owns `text`, `hash`, `revision` and `updatedAt`. `revision` is 8 hex of the rendered
 *   text AND the person's switch, and `baseRevision` makes a PUT conditional (409), so a stale save
 *   can undo neither a newer rule list nor a newer Off. `hash` (the text alone) is what finalize
 *   answers and telemetry carry.
 * - `enabled: false` (the person's switch) stops it applying everywhere and keeps the rules. Reset
 *   (DELETE) clears the rules and leaves the switch as it was.
 *   COS_DICTATION_LEARNED_STYLE=0 (the server's switch) does the same, whatever the file says.
 * - Stored atomically in the data dir, mode 0600, re-validated on every read; a corrupt file reads
 *   as empty and is logged as a code only. The rules are never logged; telemetry carries a flag
 *   and an 8-hex hash. Never for meeting lines.
 */
export const LEARNED_STYLE_PROTOCOL = 1
export const LEARNED_STYLE_MAX_CHARS = 1_500
export const LEARNED_STYLE_MAX_RULES = 20
export const LEARNED_STYLE_FILE = 'dictation-learned-style.json'

export const LEARNED_STYLE_KINDS = ['drop_phrase', 'contractions'] as const
export type LearnedStyleKind = typeof LEARNED_STYLE_KINDS[number]
export const LEARNED_STYLE_REGISTERS = ['all'] as const
export type LearnedStyleRegister = typeof LEARNED_STYLE_REGISTERS[number]
export const CONTRACTION_PARAMS = ['use', 'avoid'] as const

/**
 * The closed list of phrases a drop_phrase rule may name. Never a negation, a scope word, a number,
 * one of the built-in polish fillers (um, uh, like, you know, I mean, sort of, kind of, basically,
 * so, well), or a word that often carries meaning (like, so, just, right, actually, really).
 */
export const LEARNED_STYLE_ALLOWLIST = [
  'honestly', 'literally', 'pretty much', 'i guess', 'to be honest', 'frankly', 'obviously',
  'kinda', 'sorta', 'you see', 'at the end of the day', 'if that makes sense',
] as const

export interface LearnedStyleRule {
  id: string
  kind: LearnedStyleKind
  register: LearnedStyleRegister
  param: string
  count: number
  lastSeen: string | null
}

export function learnedStyleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_DICTATION_LEARNED_STYLE, true)
}

/** The one place the words come from: a template per kind, filled with a closed-set param. */
export function ruleText(rule: Pick<LearnedStyleRule, 'kind' | 'param'>): string {
  if (rule.kind === 'drop_phrase') return `Drop "${rule.param}" where the speaker used it as filler.`
  return rule.param === 'use'
    ? 'Use contractions where they fit ("I am" becomes "I\'m", "do not" becomes "don\'t").'
    : 'Write contractions out in full ("I\'m" becomes "I am", "don\'t" becomes "do not").'
}

/** The stored, shown and hashed text: one "- " line per rule, from the templates only. */
export function renderLearnedStyle(rules: Array<Pick<LearnedStyleRule, 'kind' | 'param'>>): string {
  return rules.map(rule => `- ${ruleText(rule)}`).join('\n')
}

/** 8 hex characters: enough to tell two settings apart in a log, never the rules. '' for none. */
export function learnedStyleHash(text: string): string {
  return text ? createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8) : ''
}

/** 8 hex of the rendered text and the switch: what a conditional PUT names as its base. Always 8. */
export function learnedStyleRevision(text: string, enabled: boolean): string {
  return createHash('sha256').update(`${enabled ? 'on' : 'off'}\n${text}`, 'utf8').digest('hex').slice(0, 8)
}

const RULE_ID = /^[a-z0-9_-]{1,40}$/
const RULE_KEYS = new Set(['id', 'kind', 'register', 'param', 'count', 'lastSeen'])

export type RulesResult =
  | { ok: true; rules: LearnedStyleRule[] }
  | { ok: false; status: 400 | 413; error: string; index?: number; max?: number }

/** Validate rules exactly; one bad rule refuses the whole list. Pure. */
export function validateLearnedStyleRules(raw: unknown): RulesResult {
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'rules_not_an_array' }
  if (raw.length > LEARNED_STYLE_MAX_RULES) return { ok: false, status: 413, error: 'too_many_rules', max: LEARNED_STYLE_MAX_RULES }
  const rules: LearnedStyleRule[] = []
  const ids = new Set<string>()
  const meanings = new Map<string, string>()
  for (let index = 0; index < raw.length; index++) {
    const rule = raw[index]
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !Object.keys(rule).every(key => RULE_KEYS.has(key))) {
      return { ok: false, status: 400, error: 'invalid_rule', index }
    }
    const { id, kind, register, param, count, lastSeen } = rule as Record<string, unknown>
    if (typeof id !== 'string' || !RULE_ID.test(id) || ids.has(id)) return { ok: false, status: 400, error: 'invalid_rule_id', index }
    if (typeof kind !== 'string' || !(LEARNED_STYLE_KINDS as readonly string[]).includes(kind)) return { ok: false, status: 400, error: 'invalid_rule_kind', index }
    if (typeof register !== 'string' || !(LEARNED_STYLE_REGISTERS as readonly string[]).includes(register)) {
      return { ok: false, status: 400, error: 'invalid_rule_register', index }
    }
    const allowed: readonly string[] = kind === 'drop_phrase' ? LEARNED_STYLE_ALLOWLIST : CONTRACTION_PARAMS
    if (typeof param !== 'string' || !allowed.includes(param)) return { ok: false, status: 400, error: 'invalid_rule_param', index }
    const n = count ?? 0
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000) return { ok: false, status: 400, error: 'invalid_rule_count', index }
    let seen: string | null = null
    if (lastSeen !== undefined && lastSeen !== null) {
      if (typeof lastSeen !== 'string' || lastSeen.length > 40 || Number.isNaN(Date.parse(lastSeen))) {
        return { ok: false, status: 400, error: 'invalid_rule_last_seen', index }
      }
      seen = new Date(Date.parse(lastSeen)).toISOString()
    }
    // One rule per meaning: two drops of one phrase, or "use" and "avoid" together, is a client bug.
    const meaning = kind === 'drop_phrase' ? `drop:${param}` : 'contractions'
    if (meanings.has(meaning)) return { ok: false, status: 400, error: meanings.get(meaning) === param ? 'duplicate_rule' : 'conflicting_rules', index }
    meanings.set(meaning, param)
    ids.add(id)
    rules.push({ id, kind: kind as LearnedStyleKind, register: register as LearnedStyleRegister, param, count: n, lastSeen: seen })
  }
  if (renderLearnedStyle(rules).length > LEARNED_STYLE_MAX_CHARS) return { ok: false, status: 413, error: 'learned_style_too_long', max: LEARNED_STYLE_MAX_CHARS }
  return { ok: true, rules }
}

/**
 * The lines one polish gets, or '' when nothing applies: the person switched it off, the target
 * is literal (a terminal never restyles), or there are no rules. Every rule is `all` in the MVP.
 */
export function learnedStyleLinesFor(stored: StoredLearnedStyle, register: DictationRegister): string {
  if (!stored.enabled || register === 'literal' || !stored.rules.length) return ''
  return renderLearnedStyle(stored.rules.filter(rule => rule.register === 'all'))
}

const filePath = () => dataPath(LEARNED_STYLE_FILE)

export interface StoredLearnedStyle {
  enabled: boolean; rules: LearnedStyleRule[]; text: string; hash: string; revision: string; updatedAt: string | null
}
const empty = (): StoredLearnedStyle => ({ enabled: true, rules: [], text: '', hash: '', revision: learnedStyleRevision('', true), updatedAt: null })

let cache: { mtimeMs: number; size: number; value: StoredLearnedStyle } | null = null
let warned = false

function warnOnce(code: string): void {
  if (warned) return
  warned = true
  // A code only. The file's contents are the person's style and are never logged.
  console.warn(`[dictation-polish] learned style unreadable (${code}); polish runs without it until it is saved again`)
}

const copy = (value: StoredLearnedStyle): StoredLearnedStyle => ({ ...value, rules: value.rules.map(rule => ({ ...rule })) })

function build(enabled: boolean, rules: LearnedStyleRule[], updatedAt: string | null): StoredLearnedStyle {
  const text = renderLearnedStyle(rules)
  return { enabled, rules, text, hash: learnedStyleHash(text), revision: learnedStyleRevision(text, enabled), updatedAt }
}

/** The stored setting, validated again on every read. Missing or corrupt reads as empty. mtime-cached. */
export function readLearnedStyle(): StoredLearnedStyle {
  let stat: { mtimeMs: number; size: number }
  try { const s = statSync(filePath()); stat = { mtimeMs: s.mtimeMs, size: s.size } } catch { cache = null; return empty() }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return copy(cache.value)
  let value = empty()
  try {
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
    const clean = validateLearnedStyleRules(parsed?.rules)
    if (clean.ok && (parsed.enabled === undefined || typeof parsed.enabled === 'boolean')) {
      value = build(parsed.enabled !== false, clean.rules, typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null)
    } else {
      warnOnce(clean.ok ? 'enabled' : clean.error)
    }
  } catch {
    warnOnce('parse')
  }
  cache = { ...stat, value }
  return copy(value)
}

/** Save validated rules. No rules and enabled is the empty state, which deletes the file. */
export function writeLearnedStyle(enabled: boolean, rules: LearnedStyleRule[], now: Date = new Date()): StoredLearnedStyle {
  cache = null
  if (!rules.length && enabled) {
    try { unlinkSync(filePath()) } catch (err: any) { if (err?.code !== 'ENOENT') throw err }
    return empty()
  }
  const stored = build(enabled, rules, now.toISOString())
  atomicWriteFileSync(filePath(), JSON.stringify({ version: LEARNED_STYLE_PROTOCOL, enabled, rules, updatedAt: stored.updatedAt }, null, 2) + '\n', { mode: 0o600 })
  return copy(stored)
}

export function __resetLearnedStyleCacheForTests(): void { cache = null; warned = false }
