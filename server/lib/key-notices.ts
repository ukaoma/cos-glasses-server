// Key lanes (K1, plan v4 section 11, 14.2 row P8): the ONE source of every string COS shows when an
// answer deviates from the user's plan. First-time notices, status labels, profile-specific error
// lines, the plan-limit offer, the keyed-session refusal, the removed-profile break, the phone and
// Mac-away lines, connectors off, and what leaves this Mac. P3, P5, P9 and P10 call this; nobody
// else writes these words.
//
// PURE. No file, env, clock, timer or socket: the caller passes seen-state, the time and the time
// zone in, and persists what comes back (`deviation-notices.json` on the Mac, bridge storage on the
// phone). The only import is the frozen P1 contract (types plus BREAKER_LIMITS). Importing this
// module with key lanes off changes nothing, and the app can copy it as is.
//
// LENS BUDGET (tested in key-notices.test.ts against Even's own font metrics, copied read only from
// `@evenrealities/pretext` 0.1.4 as pinned by cos-glasses-app f02fab64):
//   - a first-time body is at most 6 rendered lines, every body line is ONE lens row;
//   - a status label, header or footer fits the 568 px chrome row;
//   - no glyph the lens font lacks (it draws them as ~4 px of nothing);
//   - no em dash, en dash or arrow (house rule), never "sign in" in key copy.
// Fields the user typed (profile label, model label, a settings name) are cleaned of blank glyphs
// and cut with `…` by an upper-bound pixel width, so no input can push a line past its row.
import { BREAKER_LIMITS } from './key-relay-contract.js'
import type { KeyKind, RelayFailureKind } from './key-relay-contract.js'

// ── Budgets ──────────────────────────────────────────────────────────────────

/** Rendered body lines a lens notice may take (the detail body holds 6). */
export const KEY_NOTICE_BODY_LINES = 6
/** What one body line may measure: the firmware wraps at 548 px, less the app's 2 px margin. */
export const KEY_NOTICE_BODY_PX = 546
/** Lens columns per body line, the app's `JOB_TRAIL_WIDTH`. */
export const KEY_NOTICE_BODY_COLUMNS = 62
/** A full-width chrome row (header, status, footer): 576 px less 4 px a side, the app's `LENS_CHROME_ROW_PX`. */
export const KEY_NOTICE_CHROME_PX = 568

/** Glyphs the G2 lens font lacks (plan 11.2, brief rule 8). Never written by this module. */
export const KEY_NOTICE_BLANK_GLYPHS = ['♦', '✓', '⚠', '↻', '↺', '⌛', '⋯', '░', '▓', '⬡'] as const

/** The status label mark (drawn, 20 px) and the ASCII separator. */
export const KEY_LABEL_MARK = '◈'
export const KEY_LABEL_SEPARATOR = ' | '

// ── Width (upper bound) ──────────────────────────────────────────────────────
// Even's LVGL font metrics (`@evenrealities/pretext` 0.1.4, the version cos-glasses-app f02fab64
// pins), copied read only: the pixel advance of printable ASCII (the same table as the app's
// `lens-text-width.ts`) and of the symbols this module draws. Kerning narrows almost every pair; it
// widens a pair by at most 1 px, and only after the glyphs in KERN_WIDENS (41 of 10,404 pairs, all
// +1). So the sum of advances plus 1 px after those glyphs never measures below Even's own layout,
// and stays within about 10% of it. An unlisted glyph takes its class width and 1 px a side, as the
// app's bound does. key-notices.test.ts checks the bound against the replayed metrics.

const ASCII_PX = [
  5, 4, 6, 15, 13, 14, 16, 4, 7, 7, 8, 10, 5, 10, 5, 8,
  12, 8, 12, 12, 13, 12, 12, 13, 12, 12, 4, 5, 10, 10, 10, 12,
  17, 14, 12, 12, 12, 11, 11, 12, 12, 6, 9, 12, 10, 16, 12, 12,
  12, 12, 12, 12, 12, 12, 14, 16, 14, 14, 13, 7, 8, 7, 10, 9,
  4, 12, 11, 11, 11, 11, 10, 11, 11, 4, 7, 10, 4, 16, 11, 11,
  11, 11, 8, 11, 8, 12, 12, 16, 12, 12, 10, 9, 4, 9, 16,
] as const
const SYMBOL_PX: Readonly<Record<string, number>> = { '◈': 20, '…': 10, '·': 5, '√': 13, '×': 10, '◐': 20, '▒': 20 }
const KERN_WIDENS = new Set([' ', '1', 'H', 'M', 'N', ']', 'd', 'i', 'j', 'l', '|'])

/** The advance of a measured glyph, or undefined for one this table does not carry. */
function knownPx(glyph: string): number | undefined {
  const cp = glyph.codePointAt(0) ?? 0
  if (cp >= 0x20 && cp <= 0x7e) return ASCII_PX[cp - 0x20]!
  return Object.prototype.hasOwnProperty.call(SYMBOL_PX, glyph) ? SYMBOL_PX[glyph] : undefined
}

function classPx(glyph: string): number {
  const cp = glyph.codePointAt(0) ?? 0
  if (cp >= 0x1f000) return 24
  return cp < 0x2000 ? 16 : 20
}

/** Upper-bound width in px of `text` on one lens row. */
export function keyNoticeWidthPx(text: string): number {
  const glyphs = [...text]
  let width = 0
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!
    const px = knownPx(g)
    width += px ?? classPx(g)
    const next = glyphs[i + 1]
    if (next !== undefined && (px === undefined || knownPx(next) === undefined || KERN_WIDENS.has(g))) width += 1
  }
  return width
}

// ── Cleaning user text for the lens ──────────────────────────────────────────

/** Odd spaces, zero-width and direction marks, line and paragraph separators, the BOM. */
const SPACE_LIKE = (cp: number) =>
  (cp >= 0x2000 && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x205f && cp <= 0x206f) || cp === 0xfeff

/** Blank glyph (and the backtick, which the font also lacks) to a drawn look-alike, else `?`. */
const BLANK_TO_DRAWN: Readonly<Record<string, string>> = {
  '`': "'", '✓': '√', '⚠': '!', '⋯': '…', '⌛': '◐', '░': '▒', '▓': '▒', '⬡': '◈', '♦': '?', '↻': '?', '↺': '?',
}

/**
 * A user-typed field as one lens-safe row: no line breaks or control characters, no blank glyph,
 * no em or en dash, spaces collapsed. Never used for anything sent back to a provider.
 */
export function keyNoticeField(value: unknown): string {
  if (typeof value !== 'string') return ''
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || SPACE_LIKE(cp)) out += ' '
    else if (ch === '—' || ch === '–') out += '-'
    else out += BLANK_TO_DRAWN[ch] ?? ch
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/** `text` cut to fit `maxPx` and `maxColumns`, with `…` when cut. */
function fitField(text: string, maxPx: number, maxColumns: number): string {
  const fits = (s: string) => keyNoticeWidthPx(s) <= maxPx && [...s].length <= maxColumns
  if (fits(text)) return text
  const glyphs = [...text]
  for (let n = glyphs.length - 1; n > 0; n--) {
    const candidate = `${glyphs.slice(0, n).join('').trimEnd()}…`
    if (fits(candidate)) return candidate
  }
  return fits('…') ? '…' : ''
}

/** Fill `{f}` in `template` with `field`, cutting the field so the line fits one row. */
function fillRow(template: string, field: string, maxPx: number, maxColumns: number): string {
  const [before, after] = template.split('{f}') as [string, string]
  const restPx = keyNoticeWidthPx(before + after) + 2 // each join can add 1 px (KERN_WIDENS, unlisted glyphs)
  const restCols = [...before].length + [...after].length
  return before + fitField(field, maxPx - restPx, maxColumns - restCols) + after
}
const bodyRow = (template: string, field: string) => fillRow(template, field, KEY_NOTICE_BODY_PX, KEY_NOTICE_BODY_COLUMNS)
/** A closed-set field (a provider name, a formatted amount or clock): never cut; the tests prove every value fits. */
const put = (template: string, value: string) => template.replace('{f}', () => value)
const chromeRow = (template: string, field: string) => fillRow(template, field, KEY_NOTICE_CHROME_PX, 1000)

// ── Providers ────────────────────────────────────────────────────────────────

export interface KeyProviderCopy {
  /** "your OpenRouter key" is `your ${key}`. */
  key: string
  /** Where the question goes, mid-sentence. */
  dest: string
  /** The same at the start of a sentence. */
  Dest: string
  /** No daily usage API: spend is the local ledger, labeled as an estimate (plan 4.5). */
  estimate: boolean
}

export const KEY_PROVIDER_COPY: Readonly<Record<KeyKind, KeyProviderCopy>> = {
  openrouter: { key: 'OpenRouter key', dest: 'OpenRouter', Dest: 'OpenRouter', estimate: false },
  anthropic: { key: 'Anthropic key', dest: 'Anthropic', Dest: 'Anthropic', estimate: true },
  openai: { key: 'OpenAI key', dest: 'OpenAI', Dest: 'OpenAI', estimate: true },
  'openai-compatible': { key: 'endpoint key', dest: 'your endpoint', Dest: 'Your endpoint', estimate: true },
}
const UNKNOWN_PROVIDER: KeyProviderCopy = { key: 'key', dest: 'the provider', Dest: 'The provider', estimate: true }
const providerCopy = (kind: KeyKind | undefined): KeyProviderCopy =>
  (kind && Object.prototype.hasOwnProperty.call(KEY_PROVIDER_COPY, kind) ? KEY_PROVIDER_COPY[kind] : UNKNOWN_PROVIDER)

// ── Money and time ───────────────────────────────────────────────────────────

/** A cap or a day's spend: `$1.00`. */
export function formatKeyUsd(usd: number): string {
  return `$${(Number.isFinite(usd) && usd > 0 ? usd : 0).toFixed(2)}`
}

/** One answer's cost: `$0.004` under a cent, `$0.12` above, `<$0.001` for a trace. */
export function formatAnswerUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.000'
  if (usd < 0.001) return '<$0.001'
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

function timeParts(at: Date, timeZone: string | undefined): { hour: string; minute: string; dayPeriod: string } {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).formatToParts(at)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  // Built from parts, never from `format()`: ICU puts U+202F before AM/PM.
  return { hour: get('hour'), minute: get('minute'), dayPeriod: get('dayPeriod').toUpperCase() }
}

/** The local time the key's day resets: the next UTC midnight (OpenRouter `usage_daily`), e.g. `7 PM`. */
export function keyCapResetTime(now: Date, timeZone?: string): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  const { hour, minute, dayPeriod } = timeParts(next, timeZone)
  return minute === '00' ? `${hour} ${dayPeriod}` : `${hour}:${minute} ${dayPeriod}`
}

/** `2:14`, the plan 11.1 / 11.2 clock for "Mac away since". */
export function keyClock(at: Date, timeZone?: string): string {
  const { hour, minute } = timeParts(at, timeZone)
  return `${hour}:${minute}`
}

// ── First-time notice and status label (plan 11.1, 11.2) ─────────────────────

/** Plan 11.1 rows. `lane-b-claude` is the base notice. */
export type KeyNoticeVariant =
  | 'lane-b-claude'
  | 'lane-b-codex'
  | 'c1-tools-off'
  | 'c1-tools-on'
  | 'c2-phone'
  | 'k3-second-opinion'
export const KEY_NOTICE_VARIANTS: readonly KeyNoticeVariant[] = [
  'lane-b-claude', 'lane-b-codex', 'c1-tools-off', 'c1-tools-on', 'c2-phone', 'k3-second-opinion',
]

/** Body line 1: who answered. */
type Answered = 'mac' | 'phone'
/** Body line 3: what the answer could use. */
type Tools = 'harness-claude' | 'harness-codex' | 'none' | 'phone'
/** Body line 4: what leaves this Mac. */
type Egress = 'question' | 'question-and-answer'
/** Body line 5: meetings and memories. */
type Meetings = 'tool-may-read' | 'tool-reads-goes' | 'stay'

const VARIANT_SHAPE: Readonly<Record<KeyNoticeVariant, { answered: Answered; tools: Tools; egress: Egress; meetings: Meetings; lane: 'Key' | 'Direct' }>> = {
  'lane-b-claude': { answered: 'mac', tools: 'harness-claude', egress: 'question', meetings: 'tool-may-read', lane: 'Key' },
  'lane-b-codex': { answered: 'mac', tools: 'harness-codex', egress: 'question', meetings: 'tool-may-read', lane: 'Key' },
  'c1-tools-off': { answered: 'mac', tools: 'none', egress: 'question', meetings: 'stay', lane: 'Direct' },
  'c1-tools-on': { answered: 'mac', tools: 'harness-claude', egress: 'question', meetings: 'tool-reads-goes', lane: 'Direct' },
  'c2-phone': { answered: 'phone', tools: 'phone', egress: 'question', meetings: 'tool-may-read', lane: 'Key' },
  'k3-second-opinion': { answered: 'mac', tools: 'none', egress: 'question-and-answer', meetings: 'stay', lane: 'Key' },
}

/** The static copy, one place. `{f}` is the one field a row carries. */
export const KEY_NOTICE_COPY = {
  header: 'Your key, not your plan',
  footer: 'Tap: got it  Hold: settings',
  answeredMac: 'This answer runs on your {f}.',
  answeredPhone: 'Your phone answered. Mac away since {f}.',
  answeredPhoneNoTime: 'Your phone answered. The Mac was away.',
  cost: 'Cost comes off the key. Cap {f} a day.',
  costEstimate: 'Cost comes off the key. Cap {f} a day (estimate).',
  toolsHarnessClaude: 'Mac tools on. Claude connectors are off.',
  toolsHarnessCodex: 'Mac tools on. Steer lands after this turn.',
  toolsNone: 'No Mac tools.',
  toolsPhone: 'No Mac tools. No meetings, no tasks.',
  egressQuestion: 'Your question goes to {f}.',
  egressQuestionAndAnswer: 'Your question and this answer go to {f}.',
  meetingsToolMayRead: 'Meetings stay on the Mac unless a tool reads one.',
  meetingsToolReadsGoes: 'Meeting text it reads goes to {f}.',
  meetingsStay: 'Meetings and memories stay on the Mac.',
  labelLaneKey: 'Key',
  labelLaneDirect: 'Direct',
  labelPhone: 'Phone',
  labelMacAway: 'Mac away {f}',
  labelMacAwayNoTime: 'Mac away',
  labelNear: '{f} today',
  /** D14: the footer offer on a Lane A plan-limit error, only when a key profile exists. */
  planLimitOffer: 'Tap: run this one on your key',
  /** Plan 12: the context break a bound session gets when its profile is removed. */
  profileRemovedBreak: 'Key profile removed',
  /** An id this build does not know (a newer caller): still never a sign-in line. */
  unknownError: 'Your key could not answer this one.',
} as const

/** Spend at or above this share of the cap switches the label to the "Near" form (plan 11.2). */
export const KEY_NEAR_CAP_SHARE = 0.8

export interface KeyNoticeContext {
  variant: KeyNoticeVariant
  profileId: string
  keyKind: KeyKind
  capUsd: number
  /** Short model name for the label, e.g. `Sonnet 5.5` (see keyModelLabel). */
  modelLabel: string
  /** This answer's cost, when known. */
  costUsd?: number
  spentTodayUsd?: number
  /** C2 only: when the phone lost the Mac. */
  macAwaySince?: Date
  /** IANA zone for clock copy; the process zone when omitted. */
  timeZone?: string
}

/**
 * What the caller persists: notice fingerprint to the ISO time it was first shown. The file
 * (`deviation-notices.json`) and bridge storage hold exactly this object. A missing or unreadable
 * file is `undefined`, which shows the notice again (over-telling is the safe direction).
 */
export type KeyNoticeSeen = Readonly<Record<string, string>>

/**
 * The notice's identity. It changes, and so re-arms the notice, when the profile, key kind, tools,
 * egress (both carried by the variant) or the cap change (plan 11.1).
 */
export function keyNoticeFingerprint(ctx: Pick<KeyNoticeContext, 'variant' | 'profileId' | 'keyKind' | 'capUsd'>): string {
  const cents = Math.round((Number.isFinite(ctx.capUsd) ? ctx.capUsd : 0) * 100)
  return `key-notice:v1:${ctx.profileId}:${ctx.keyKind}:${ctx.variant}:cap${cents}`
}

export function keyNoticeSeen(seen: KeyNoticeSeen | undefined, fingerprint: string): boolean {
  return !!seen && typeof seen === 'object' && Object.prototype.hasOwnProperty.call(seen, fingerprint)
}

/** A new seen-state with `fingerprint` recorded (the input is never changed). */
export function markKeyNoticeSeen(seen: KeyNoticeSeen | undefined, fingerprint: string, at: Date): KeyNoticeSeen {
  if (keyNoticeSeen(seen, fingerprint)) return { ...seen }
  return { ...(seen ?? {}), [fingerprint]: at.toISOString() }
}

/** The five body lines of the first-time notice (plan 11.1). */
export function keyNoticeBody(ctx: KeyNoticeContext): string[] {
  const shape = VARIANT_SHAPE[ctx.variant]
  const p = providerCopy(ctx.keyKind)
  const C = KEY_NOTICE_COPY
  const line1 = shape.answered === 'phone'
    ? (ctx.macAwaySince ? put(C.answeredPhone, keyClock(ctx.macAwaySince, ctx.timeZone)) : C.answeredPhoneNoTime)
    : put(C.answeredMac, p.key)
  const line2 = put(p.estimate ? C.costEstimate : C.cost, formatKeyUsd(ctx.capUsd))
  const line3 = shape.tools === 'harness-claude' ? C.toolsHarnessClaude
    : shape.tools === 'harness-codex' ? C.toolsHarnessCodex
      : shape.tools === 'phone' ? C.toolsPhone
        : C.toolsNone
  const line4 = put(shape.egress === 'question' ? C.egressQuestion : C.egressQuestionAndAnswer, p.dest)
  const line5 = shape.meetings === 'tool-may-read' ? C.meetingsToolMayRead
    : shape.meetings === 'tool-reads-goes' ? put(C.meetingsToolReadsGoes, p.dest)
      : C.meetingsStay
  return [line1, line2, line3, line4, line5]
}

/** The status label (plan 11.2): never the body. */
export function keyStatusLabel(ctx: KeyNoticeContext): string {
  const C = KEY_NOTICE_COPY
  const shape = VARIANT_SHAPE[ctx.variant]
  const sep = KEY_LABEL_SEPARATOR
  if (shape.answered === 'phone') {
    const away = ctx.macAwaySince ? C.labelMacAway.replace('{f}', keyClock(ctx.macAwaySince, ctx.timeZone)) : C.labelMacAwayNoTime
    return `${KEY_LABEL_MARK} ${C.labelPhone}${sep}${away}`
  }
  const lane = `${KEY_LABEL_MARK} ${shape.lane === 'Direct' ? C.labelLaneDirect : C.labelLaneKey}`
  const tilde = providerCopy(ctx.keyKind).estimate ? '~' : ''
  const spent = ctx.spentTodayUsd
  if (typeof spent === 'number' && Number.isFinite(spent) && ctx.capUsd > 0 && spent >= ctx.capUsd * KEY_NEAR_CAP_SHARE) {
    return `${lane}${sep}${C.labelNear.replace('{f}', `${tilde}${formatKeyUsd(spent)} of ${formatKeyUsd(ctx.capUsd)}`)}`
  }
  const cost = typeof ctx.costUsd === 'number' ? `${sep}${tilde}${formatAnswerUsd(ctx.costUsd)}` : ''
  return chromeRow(`${lane}${sep}{f}${cost}`, keyNoticeField(ctx.modelLabel) || 'model')
}

export type KeyLaneNoticeView =
  | { form: 'first-time'; fingerprint: string; header: string; body: string[]; footer: string; label: string }
  | { form: 'compact'; fingerprint: string; label: string }

/**
 * The notice for one keyed answer: the first-time long form when `seen` has not recorded this
 * fingerprint, else the compact label. The caller shows it, then persists
 * `markKeyNoticeSeen(seen, view.fingerprint, now)` once the wearer taps "got it".
 */
export function keyLaneNotice(ctx: KeyNoticeContext, seen: KeyNoticeSeen | undefined): KeyLaneNoticeView {
  const fingerprint = keyNoticeFingerprint(ctx)
  const label = keyStatusLabel(ctx)
  if (keyNoticeSeen(seen, fingerprint)) return { form: 'compact', fingerprint, label }
  return { form: 'first-time', fingerprint, header: KEY_NOTICE_COPY.header, body: keyNoticeBody(ctx), footer: KEY_NOTICE_COPY.footer, label }
}

/** Short model name: `anthropic/claude-sonnet-5.5` to `Sonnet 5.5`; anything else, its last segment. */
export function keyModelLabel(slug: string): string {
  const last = (typeof slug === 'string' ? slug : '').split('/').pop() ?? ''
  const claude = /^claude-([a-z]+)-(\d+(?:[.-]\d+)*)$/i.exec(last)
  if (claude) return `${claude[1]!.charAt(0).toUpperCase()}${claude[1]!.slice(1).toLowerCase()} ${claude[2]!.replace(/-/g, '.')}`
  return keyNoticeField(last) || 'model'
}

// ── Plan-limit offer (D14) ───────────────────────────────────────────────────

/**
 * The footer offer on a Lane A plan-limit error. Only when a key profile exists; with none the
 * caller keeps today's message byte for byte. Never automatic: this is a label, not an action.
 */
export function planLimitOfferFooter(input: { enabledKeyProfiles: number }): string | undefined {
  return Number.isInteger(input.enabledKeyProfiles) && input.enabledKeyProfiles > 0 ? KEY_NOTICE_COPY.planLimitOffer : undefined
}

// ── Error lines (plan 11.3 and the other profile-specific refusals) ──────────

/** Every profile-specific error line. A superset of the relay's failure kinds (plan 4.6). */
export type KeyNoticeErrorId =
  | RelayFailureKind
  | 'breaker_open'
  | 'profile_off'
  | 'profile_removed'
  | 'keyed_session'
  | 'settings_override'
  | 'mac_has_turn'
  | 'dictated_key'
  | 'no_credit_limit'
  | 'downgrade'
  // QA N10 / U2: the relay ended the turn's token, or the provider refused without a reason COS names.
  | 'nonce_expired'
  | 'nonce_revoked'
  | 'upstream_refused'
  | 'relay_busy'

export interface KeyNoticeErrorParams {
  keyKind?: KeyKind
  capUsd?: number
  modelLabel?: string
  profileLabel?: string
  /** `settings_override`: the env name or `apiKeyHelper` a Claude settings file sets. */
  settingName?: string
  /** `cap_refused`: now, for the reset time. */
  now?: Date
  timeZone?: string
}

const hours = Math.round(BREAKER_LIMITS.openMs / 3_600_000)

/** One template per id; `{f}` is the field `render` fills. */
const ERRORS: { readonly [K in KeyNoticeErrorId]: (p: KeyNoticeErrorParams) => string } = {
  key_rejected: p => put('Your {f} was rejected. Fix it in COS Control.', providerCopy(p.keyKind).key),
  out_of_credit: p => put('Your {f} is out of credit.', providerCopy(p.keyKind).key),
  cap_refused: p => {
    const reset = p.now ? ` Resets ${keyCapResetTime(p.now, p.timeZone)}.` : ''
    return put(`Today's {f} cap on this key is used.${reset}`, formatKeyUsd(p.capUsd ?? 0))
  },
  model_gone: p => bodyRow(`{f} is no longer on ${providerCopy(p.keyKind).dest}. Pick a model.`, keyNoticeField(p.modelLabel) || 'This model'),
  rate_limited: p => put('{f} is busy for this key. Try again in a minute.', providerCopy(p.keyKind).Dest),
  upstream_error: p => put('{f} had an error. Your plan was not used.', providerCopy(p.keyKind).Dest),
  network_error: p => put('Could not reach {f}. Your plan was not used.', providerCopy(p.keyKind).dest),
  model_not_allowed: () => 'COS stopped a model this key profile does not allow.',
  breaker_open: () => `Key paused ${hours} hour${hours === 1 ? '' : 's'} after ${BREAKER_LIMITS.failures} failures.`,
  profile_off: p => bodyRow('Key profile {f} is off. Pick a model.', keyNoticeField(p.profileLabel) || 'for this thread'),
  profile_removed: () => "This thread's key profile was removed. Pick a model.",
  keyed_session: () => 'This session ran on your key. Continue it from COS.',
  // Two rows: the plan's sentence is wider than one (plan 7.2).
  settings_override: p => `${bodyRow('A Claude settings file sets {f}.', keyNoticeField(p.settingName) || 'a provider name')}\nRemove it to use a key.`,
  mac_has_turn: () => 'Mac has this one. Waiting.',
  dictated_key: () => 'Keys only by paste, on the phone.',
  no_credit_limit: () => 'Set a credit limit on this key at openrouter.ai first.',
  downgrade: () => 'Remove your keys first. Older COS cannot see them.',
  nonce_expired: () => 'This key turn ran past its time limit. Your plan was not used.',
  nonce_revoked: () => 'This key turn was stopped. Your plan was not used.',
  upstream_refused: p => put('{f} refused this request. Your plan was not used.', providerCopy(p.keyKind).Dest),
  relay_busy: () => 'Too many steps at once. Your plan was not used.',
}
export const KEY_NOTICE_ERROR_IDS = Object.keys(ERRORS) as KeyNoticeErrorId[]

/** The lens line for a key-lane failure or refusal. Never mentions signing in. */
export function keyNoticeError(id: KeyNoticeErrorId, params: KeyNoticeErrorParams = {}): string {
  const render = Object.prototype.hasOwnProperty.call(ERRORS, id) ? ERRORS[id] : undefined
  return render ? render(params) : KEY_NOTICE_COPY.unknownError
}

// ── Lane refusal lines (plan 11.3, 5.2, 9.4) ─────────────────────────────────
// Moved here by P11 so this module stays the one source: P3 (lane-b-env.ts LANE_B_COPY), P4
// (codex-profile-home.ts CODEX_LANE_B_COPY), P5 (direct-bridge.ts DIRECT_COPY) and P6
// (key-profile-routing.ts, key-profile-rejects.ts) now read their lines from this object. Each line
// is one lens row with a typical label; no em dashes, no arrows, no sign-in wording.

/**
 * QA B1 (main session decision): the plain same-Mac residual risk, shown by COS Control and in the
 * changelog. Exact wording agreed with Control; do not edit without its pin.
 */
export const KEY_LANE_SAME_MAC_COPY = "Your key is saved on this Mac. Apps and agents that run on this Mac as you can read it. Your provider's spending limit is the real stop."

/**
 * Canary rerun item 2: the cap is checked as a reply streams, so the reply already in progress can
 * pass it by up to one response. Shown by COS Control beside the cap (and in the changelog).
 */
export const KEY_CAP_OVERSHOOT_COPY = 'The cap can be exceeded by the last reply in progress. Your provider limit is the hard stop.'

export const KEY_LANE_REFUSAL_COPY = {
  lanesOff: 'Key lanes are off. Pick a model.',
  profileOff: (label: string) => `Key profile ${label} is off. Pick a model.`,
  profileUnavailable: (label: string) => `Key profile ${label} cannot answer on this server yet. Pick a model.`,
  wrongEngineClaude: (label: string) => `Key profile ${label} is not a Claude profile. Pick a model.`,
  wrongEngineCodex: (label: string) => `Key profile ${label} is not a Codex profile. Pick a model.`,
  wrongEngineDirect: 'This key profile is not a direct profile. Pick a model.',
  keyMissing: (label: string) => `The key for profile ${label} is not saved on this Mac. Fix it in COS Control.`,
  codexModelNotAllowed: (label: string) => `Key profile ${label} has a model Codex cannot run. Pick a model.`,
  scheduled: 'Key profiles cannot run scheduled briefs.',
  workNotYet: 'Key sessions are not in Work yet.',
  relayUnavailable: 'Your key could not start this turn. Your plan was not used.',
  codexProjectConfig: (name: string) => `A Codex project config sets ${name}. Remove it to use a key.`,
  v1NotOffered: 'That key profile is not offered on /v1. Turn on Offer on /v1 in COS Control.',
  directCopyUnavailable: 'Your key could not answer this one.',
  directNoEndpoint: 'This key cannot answer direct. Pick a model.',
  directTextOnly: 'Direct key answers are text only. Remove the photo and retry.',
  directEmpty: 'The model finished without an answer. Your plan was not used.',
  directToolCap: 'The model hit its tool round cap without an answer. Ask a narrower question.',
  directCancelled: 'That answer was cancelled.',
} as const
