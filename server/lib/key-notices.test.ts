// Key lanes P8 (plan v4 sections 11 and 14.2 row P8): every key notice, label and error line, as the
// G2 lens lays it out.
//
// HOW LINES ARE MEASURED. The app measures lens text with Even's own LVGL font metrics,
// `@evenrealities/pretext` 0.1.4 (pinned by cos-glasses-app f02fab64, `src/lib/lens-text.ts`,
// `countLensLines` in `src/lib/job-trail-view.ts`). The server does not depend on pretext, so
// `__fixtures__/key-notices/build-lens-metrics.mjs` copied, read only, the advance of every glyph a
// notice can draw and the kerned advance of every ordered pair of them, plus which code points the
// font carries. `wrap()` below replays pretext's `measureTextWrap` on that table (same breaking,
// same per-glyph rounding, same 4 px placeholder) and is checked against pretext's own output for
// the fixture's sample lines. `rows()` is the app's `countLensLines`: per line, the larger of the
// firmware wrap at 548 px and the 62-column count.
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KeyKind, RelayFailureKind } from './key-relay-contract.js'
import {
  KEY_NOTICE_BLANK_GLYPHS,
  KEY_NOTICE_BODY_LINES,
  KEY_NOTICE_CHROME_PX,
  KEY_NOTICE_COPY,
  KEY_NOTICE_ERROR_IDS,
  KEY_NOTICE_VARIANTS,
  keyCapResetTime,
  keyClock,
  keyLaneNotice,
  keyModelLabel,
  keyNoticeBody,
  keyNoticeError,
  keyNoticeField,
  keyNoticeFingerprint,
  keyNoticeWidthPx,
  keyStatusLabel,
  markKeyNoticeSeen,
  planLimitOfferFooter,
  formatAnswerUsd,
  type KeyNoticeContext,
  type KeyNoticeErrorId,
  type KeyNoticeSeen,
} from './key-notices.js'

const here = dirname(fileURLToPath(import.meta.url))
const METRICS = JSON.parse(readFileSync(join(here, '__fixtures__/key-notices/lens-metrics-pretext-0.1.4.json'), 'utf8')) as {
  source: string
  adv: Record<string, number>
  pairs: Record<string, number>
  advW: Record<string, number>
  checks: Array<{ text: string; width: number; lineWidths: number[] }>
}
/** The firmware wrap edge (app `LENS_TEXT_EDGE_PX`) and the app's 2 px margin (`LENS_BODY_TEXT_PX`). */
const LENS_TEXT_EDGE_PX = 548
const LENS_BODY_TEXT_PX = 546
const JOB_TRAIL_WIDTH = 62

const measured = (ch: string) => Object.prototype.hasOwnProperty.call(METRICS.adv, String(ch.codePointAt(0)))

/** pretext getAdvWPx(cp, next) from the table. Throws on a glyph the table does not carry. */
function advPx(cp: number, next: number): number {
  const own = METRICS.adv[String(cp)]
  if (own === undefined) throw new Error(`unmeasured glyph U+${cp.toString(16)}`)
  if (!next) return own
  const pair = METRICS.pairs[`${cp},${next}`]
  return pair ?? own
}

/** Replay of pretext 0.1.4 `measureTextWrap` (LVGL lv_text_get_next_line). */
function wrap(text: string, maxWidth: number): number[] {
  if (!text) return []
  const lineWidths: number[] = []
  let current = 0
  let lastBreakIdx = -1
  let lastBreakWidth = 0
  const cps = Array.from(text).map(c => c.codePointAt(0)!)
  let i = 0
  while (i < cps.length) {
    const cp = cps[i]!
    if (cp === 10) { lineWidths.push(current); current = 0; lastBreakIdx = -1; i++; continue }
    if (current === 0 && cp === 32) { i++; continue }
    const adv = advPx(cp, cps[i + 1] ?? 0)
    if (current + adv > maxWidth) {
      if (cp === 32) { lineWidths.push(current); current = 0; lastBreakIdx = -1; i++ }
      else if (lastBreakIdx !== -1) { lineWidths.push(lastBreakWidth); current = 0; i = lastBreakIdx + 1; lastBreakIdx = -1 }
      else { lineWidths.push(current); current = adv; lastBreakIdx = -1; i++ }
    } else {
      current += adv
      if (cp === 32 || cp === 45) { lastBreakIdx = i; lastBreakWidth = cp === 32 ? current - adv : current }
      i++
    }
  }
  lineWidths.push(current)
  return lineWidths
}
const exactWidth = (line: string) => Array.from(line).reduce((w, ch, i, all) => w + advPx(ch.codePointAt(0)!, all[i + 1]?.codePointAt(0) ?? 0), 0)

/** The app's countLensLines(text, 62). */
function rows(text: string): number {
  let total = 0
  for (const line of text.split('\n')) {
    const cols = Array.from(line).length
    const firmware = line ? wrap(line, LENS_TEXT_EDGE_PX).length : 1
    total += Math.max(1, Math.ceil(cols / JOB_TRAIL_WIDTH), firmware)
  }
  return total
}

const KINDS: KeyKind[] = ['openrouter', 'anthropic', 'openai', 'openai-compatible']
const TZ = 'America/Chicago'
const NOW = new Date('2026-10-19T19:30:00Z')
const AWAY = new Date('2026-10-19T19:14:00Z')
const ctx = (over: Partial<KeyNoticeContext> = {}): KeyNoticeContext => ({
  variant: 'lane-b-claude', profileId: 'sonnet', keyKind: 'openrouter', capUsd: 1, modelLabel: 'Sonnet 5.5',
  costUsd: 0.004, macAwaySince: AWAY, timeZone: TZ, ...over,
})
const errParams = { keyKind: 'openrouter' as KeyKind, capUsd: 1, modelLabel: 'Sonnet 5.5', profileLabel: 'Sonnet', settingName: 'ANTHROPIC_BASE_URL', now: NOW, timeZone: TZ }

// Worst cases for every field a user or provider controls.
const WIDE = ['W'.repeat(40), '@'.repeat(40), 'M'.repeat(40), 'WM@'.repeat(14), 'i'.repeat(40), 'a'.repeat(40)]
const HOSTILE = ['✓ Sonnet ⚠ fast', '⬡⬡⬡ ♦ ↻ ↺ ⌛ ⋯ ░ ▓', 'line\nbreak\ttab', 'dash — en – done', 'zero\u200bwidth\u2028sep', '`tick`', '', '   ']
const CAPS = [0.01, 1, 9.99, 999.99, 1000]
const CLOCKS = [new Date('2026-10-19T17:59:00Z'), new Date('2026-10-19T05:00:00Z'), AWAY]

/** Every string the module can emit across the worst-case grid, with where it renders. */
type Rendering = { where: 'body' | 'chrome' | 'error'; text: string; from: string; /** No user-typed field went in. */ clean: boolean }
function everyRendering(): Rendering[] {
  const out: Rendering[] = []
  for (const variant of KEY_NOTICE_VARIANTS) for (const keyKind of KINDS) for (const capUsd of CAPS) for (const macAwaySince of [...CLOCKS, undefined]) {
    const money: Array<[number | undefined, number | undefined]> = [[undefined, 0.004], [undefined, undefined], [0, 999.99], [capUsd * 0.79, 0.0004], [capUsd * 0.8, undefined], [capUsd * 5, 0]]
    for (const modelLabel of [...WIDE, ...HOSTILE, 'Sonnet 5.5']) for (const [spent, costUsd] of money) {
      const c = ctx({ variant, keyKind, capUsd, macAwaySince, modelLabel, spentTodayUsd: spent, costUsd })
      const from = JSON.stringify({ variant, keyKind, capUsd, modelLabel, spent, costUsd, away: macAwaySince?.toISOString() })
      const clean = modelLabel === 'Sonnet 5.5'
      out.push({ where: 'chrome', text: keyStatusLabel(c), from, clean })
      if (clean && spent === undefined && costUsd === 0.004) out.push({ where: 'body', text: keyNoticeBody(c).join('\n'), from, clean })
    }
  }
  for (const id of KEY_NOTICE_ERROR_IDS) for (const keyKind of [...KINDS, undefined]) for (const field of [...WIDE, ...HOSTILE, 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'Sonnet']) for (const capUsd of CAPS) {
    const p = { keyKind, capUsd, modelLabel: field, profileLabel: field, settingName: field, now: NOW, timeZone: 'Asia/Kolkata' }
    out.push({ where: 'error', text: keyNoticeError(id, p), from: JSON.stringify({ id, keyKind, field, capUsd }), clean: field === 'Sonnet' || field === 'ANTHROPIC_DEFAULT_SONNET_MODEL' })
  }
  for (const text of [KEY_NOTICE_COPY.header, KEY_NOTICE_COPY.footer, KEY_NOTICE_COPY.planLimitOffer, KEY_NOTICE_COPY.profileRemovedBreak]) out.push({ where: 'chrome', text, from: text, clean: true })
  return out
}

describe('lens metrics replay (pretext 0.1.4, copied read only)', () => {
  it('reproduces pretext measureTextWrap on every fixture sample', () => {
    expect(METRICS.source).toMatch(/^@evenrealities\/pretext 0\.1\.4 dist\/font_measure\.js sha256 [0-9a-f]{64}$/)
    expect(METRICS.checks.length).toBeGreaterThanOrEqual(8)
    for (const { text, width, lineWidths } of METRICS.checks) expect(wrap(text, width), text).toEqual(lineWidths)
  })

  it('keyNoticeWidthPx never measures below the font, over every ordered glyph pair and random lines', () => {
    const glyphs = Object.keys(METRICS.adv).map(cp => String.fromCodePoint(Number(cp)))
    for (const a of glyphs) for (const b of glyphs) expect(keyNoticeWidthPx(a + b), JSON.stringify(a + b)).toBeGreaterThanOrEqual(exactWidth(a + b))
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let n = 0; n < 3000; n++) {
      const line = Array.from({ length: 1 + Math.floor(rand() * 70) }, () => glyphs[Math.floor(rand() * glyphs.length)]).join('')
      expect(keyNoticeWidthPx(line), line).toBeGreaterThanOrEqual(exactWidth(line))
    }
  })
})

describe('strings golden (plan 11.1, 11.2, 11.3, D14, 12)', () => {
  it('first-time notice, every variant, OpenRouter, 2:14 PM CDT', () => {
    const got = Object.fromEntries(KEY_NOTICE_VARIANTS.map(v => [v, keyLaneNotice(ctx({ variant: v }), undefined)]))
    const head = { form: 'first-time', header: 'Your key, not your plan', footer: 'Tap: got it  Hold: settings' }
    const L1 = 'This answer runs on your OpenRouter key.'
    const L2 = 'Cost comes off the key. Cap $1.00 a day.'
    const L4 = 'Your question goes to OpenRouter.'
    const L5 = 'Meetings stay on the Mac unless a tool reads one.'
    expect(got).toEqual({
      'lane-b-claude': { ...head, fingerprint: 'key-notice:v1:sonnet:openrouter:lane-b-claude:cap100', label: '◈ Key | Sonnet 5.5 | $0.004',
        body: [L1, L2, 'Mac tools on. Claude connectors are off.', L4, L5] },
      'lane-b-codex': { ...head, fingerprint: 'key-notice:v1:sonnet:openrouter:lane-b-codex:cap100', label: '◈ Key | Sonnet 5.5 | $0.004',
        body: [L1, L2, 'Mac tools on. Steer lands after this turn.', L4, L5] },
      'c1-tools-off': { ...head, fingerprint: 'key-notice:v1:sonnet:openrouter:c1-tools-off:cap100', label: '◈ Direct | Sonnet 5.5 | $0.004',
        body: [L1, L2, 'No Mac tools.', L4, 'Meetings and memories stay on the Mac.'] },
      'c1-tools-on': { ...head, fingerprint: 'key-notice:v1:sonnet:openrouter:c1-tools-on:cap100', label: '◈ Direct | Sonnet 5.5 | $0.004',
        body: [L1, L2, 'Mac tools on. Claude connectors are off.', L4, 'Meeting text it reads goes to OpenRouter.'] },
      'c2-phone': { ...head, fingerprint: 'key-notice:v1:sonnet:openrouter:c2-phone:cap100', label: '◈ Phone | Mac away 2:14',
        body: ['Your phone answered. Mac away since 2:14.', L2, 'No Mac tools. No meetings, no tasks.', L4, L5] },
      'k3-second-opinion': { ...head, fingerprint: 'key-notice:v1:sonnet:openrouter:k3-second-opinion:cap100', label: '◈ Key | Sonnet 5.5 | $0.004',
        body: [L1, L2, 'No Mac tools.', 'Your question and this answer go to OpenRouter.', 'Meetings and memories stay on the Mac.'] },
    })
  })

  it('provider wording and the estimate label for keys without a usage API', () => {
    expect(KINDS.map(k => keyNoticeBody(ctx({ keyKind: k, variant: 'c1-tools-on' })))).toEqual([
      ['This answer runs on your OpenRouter key.', 'Cost comes off the key. Cap $1.00 a day.', 'Mac tools on. Claude connectors are off.', 'Your question goes to OpenRouter.', 'Meeting text it reads goes to OpenRouter.'],
      ['This answer runs on your Anthropic key.', 'Cost comes off the key. Cap $1.00 a day (estimate).', 'Mac tools on. Claude connectors are off.', 'Your question goes to Anthropic.', 'Meeting text it reads goes to Anthropic.'],
      ['This answer runs on your OpenAI key.', 'Cost comes off the key. Cap $1.00 a day (estimate).', 'Mac tools on. Claude connectors are off.', 'Your question goes to OpenAI.', 'Meeting text it reads goes to OpenAI.'],
      ['This answer runs on your endpoint key.', 'Cost comes off the key. Cap $1.00 a day (estimate).', 'Mac tools on. Claude connectors are off.', 'Your question goes to your endpoint.', 'Meeting text it reads goes to your endpoint.'],
    ])
    expect(keyNoticeBody(ctx({ variant: 'c2-phone', macAwaySince: undefined }))[0]).toBe('Your phone answered. The Mac was away.')
  })

  it('status labels (plan 11.2): B, C1, C2, near the cap, estimate', () => {
    expect([
      keyStatusLabel(ctx()),
      keyStatusLabel(ctx({ variant: 'c1-tools-off', modelLabel: 'Haiku 5.5', costUsd: 0.001 })),
      keyStatusLabel(ctx({ variant: 'c2-phone' })),
      keyStatusLabel(ctx({ spentTodayUsd: 0.8 })),
      keyStatusLabel(ctx({ spentTodayUsd: 0.79 })),
      keyStatusLabel(ctx({ keyKind: 'anthropic', spentTodayUsd: 0.85 })),
      keyStatusLabel(ctx({ keyKind: 'openai', costUsd: 0.12 })),
      keyStatusLabel(ctx({ costUsd: undefined })),
      keyStatusLabel(ctx({ variant: 'c2-phone', macAwaySince: undefined })),
      keyStatusLabel(ctx({ modelLabel: 'W'.repeat(40) })),
    ]).toEqual([
      '◈ Key | Sonnet 5.5 | $0.004',
      '◈ Direct | Haiku 5.5 | $0.001',
      '◈ Phone | Mac away 2:14',
      '◈ Key | $0.80 of $1.00 today',
      '◈ Key | Sonnet 5.5 | $0.004',
      '◈ Key | ~$0.85 of $1.00 today',
      '◈ Key | Sonnet 5.5 | ~$0.12',
      '◈ Key | Sonnet 5.5',
      '◈ Phone | Mac away',
      `◈ Key | ${'W'.repeat(24)}… | $0.004`,
    ])
  })

  it('error lines (plan 11.3 plus every profile-specific refusal), Chicago before the DST change', () => {
    const got = Object.fromEntries(KEY_NOTICE_ERROR_IDS.map(id => [id, keyNoticeError(id, errParams)]))
    expect(got).toEqual({
      cap_refused: "Today's $1.00 cap on this key is used. Resets 7 PM.",
      key_rejected: 'Your OpenRouter key was rejected. Fix it in COS Control.',
      out_of_credit: 'Your OpenRouter key is out of credit.',
      model_gone: 'Sonnet 5.5 is no longer on OpenRouter. Pick a model.',
      rate_limited: 'OpenRouter is busy for this key. Try again in a minute.',
      upstream_error: 'OpenRouter had an error. Your plan was not used.',
      network_error: 'Could not reach OpenRouter. Your plan was not used.',
      model_not_allowed: 'COS stopped a model this key profile does not allow.',
      breaker_open: 'Key paused 1 hour after 3 failures.',
      profile_off: 'Key profile Sonnet is off. Pick a model.',
      profile_removed: "This thread's key profile was removed. Pick a model.",
      keyed_session: 'This session ran on your key. Continue it from COS.',
      settings_override: 'A Claude settings file sets ANTHROPIC_BASE_URL.\nRemove it to use a key.',
      mac_has_turn: 'Mac has this one. Waiting.',
      dictated_key: 'Keys only by paste, on the phone.',
      no_credit_limit: 'Set a credit limit on this key at openrouter.ai first.',
      downgrade: 'Remove your keys first. Older COS cannot see them.',
    })
    expect(keyNoticeError('cap_refused', { ...errParams, now: new Date('2026-11-02T15:00:00Z') })).toBe("Today's $1.00 cap on this key is used. Resets 6 PM.")
    expect(keyNoticeError('cap_refused', { capUsd: 2.5 })).toBe("Today's $2.50 cap on this key is used.")
    expect(keyNoticeError('key_rejected', { keyKind: 'openai-compatible' })).toBe('Your endpoint key was rejected. Fix it in COS Control.')
    expect(keyNoticeError('rate_limited', { keyKind: 'openai-compatible' })).toBe('Your endpoint is busy for this key. Try again in a minute.')
    expect(keyNoticeError('profile_off', {})).toBe('Key profile for this thread is off. Pick a model.')
    expect(keyNoticeError('no_such_id' as KeyNoticeErrorId)).toBe('Your key could not answer this one.')
  })

  it('every relay failure kind (plan 4.6) has its own line', () => {
    const relayKinds: RelayFailureKind[] = ['cap_refused', 'key_rejected', 'out_of_credit', 'model_gone', 'rate_limited', 'upstream_error', 'network_error', 'model_not_allowed']
    for (const k of relayKinds) expect(KEY_NOTICE_ERROR_IDS).toContain(k)
    expect(new Set(KEY_NOTICE_ERROR_IDS.map(id => keyNoticeError(id, errParams))).size).toBe(KEY_NOTICE_ERROR_IDS.length)
  })

  it('plan-limit offer (D14) and the removed-profile break (plan 12)', () => {
    expect(planLimitOfferFooter({ enabledKeyProfiles: 0 })).toBeUndefined()
    expect(planLimitOfferFooter({ enabledKeyProfiles: Number.NaN })).toBeUndefined()
    expect(planLimitOfferFooter({ enabledKeyProfiles: 1 })).toBe('Tap: run this one on your key')
    expect(KEY_NOTICE_COPY.profileRemovedBreak).toBe('Key profile removed')
  })

  it('clock copy is built from parts, so an ICU that puts U+202F before AM/PM changes nothing', () => {
    // Node 24 (ICU 77.1) writes a plain space; Safari and other ICU builds write U+202F, which the
    // lens font does not carry. Simulate that ICU for both entry points.
    const Real = Intl.DateTimeFormat
    class NarrowSpaceIcu extends Real {
      override formatToParts(d?: Date | number): Intl.DateTimeFormatPart[] {
        return super.formatToParts(d).map(p => (p.type === 'literal' && p.value === ' ' ? { ...p, value: '\u202f' } : p))
      }
      override format(d?: Date | number): string {
        return super.format(d).replace(/ /g, '\u202f')
      }
    }
    vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: NarrowSpaceIcu })
    try {
      expect(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(NOW)).toContain('\u202f')
      expect(keyCapResetTime(NOW, TZ)).toBe('7 PM')
      expect(keyClock(AWAY, TZ)).toBe('2:14')
      expect(keyNoticeError('cap_refused', errParams)).toBe("Today's $1.00 cap on this key is used. Resets 7 PM.")
    } finally {
      vi.unstubAllGlobals()
    }
    expect(Intl.DateTimeFormat).toBe(Real)
  })

  it('clocks and money', () => {
    expect(keyCapResetTime(NOW, TZ)).toBe('7 PM')
    expect(keyCapResetTime(new Date('2026-11-02T12:00:00Z'), TZ)).toBe('6 PM')
    expect(keyCapResetTime(NOW, 'Asia/Kolkata')).toBe('5:30 AM')
    expect(keyCapResetTime(NOW, 'UTC')).toBe('12 AM')
    expect(keyClock(AWAY, TZ)).toBe('2:14')
    expect(keyClock(new Date('2026-10-19T05:05:00Z'), TZ)).toBe('12:05')
    expect([0, -1, Number.NaN, 0.0004, 0.004, 0.0123, 1.5].map(formatAnswerUsd)).toEqual(['$0.000', '$0.000', '$0.000', '<$0.001', '$0.004', '$0.01', '$1.50'])
    expect(keyModelLabel('anthropic/claude-sonnet-5.5')).toBe('Sonnet 5.5')
    expect(keyModelLabel('anthropic/claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(keyModelLabel('openai/gpt-5.5')).toBe('gpt-5.5')
    expect(keyModelLabel('')).toBe('model')
  })
})

const ALL = everyRendering()

describe('lens budget: every variant, every provider, worst-case fields', { timeout: 120_000 }, () => {
  const all = ALL

  it('first-time body: at most 6 rendered lines, every body line exactly one row', () => {
    const bodies = all.filter(r => r.where === 'body')
    expect(bodies.length).toBe(KEY_NOTICE_VARIANTS.length * KINDS.length * CAPS.length * (CLOCKS.length + 1))
    for (const { text, from } of bodies) {
      expect(rows(text), from).toBeLessThanOrEqual(KEY_NOTICE_BODY_LINES)
      for (const line of text.split('\n')) {
        expect(rows(line), `${from}: ${line}`).toBe(1)
        expect(exactWidth(line), line).toBeLessThanOrEqual(LENS_BODY_TEXT_PX)
      }
    }
  })

  it('error lines: every row one lens row, at most 2 rows, within the 6-line body', () => {
    for (const { text, from } of all.filter(r => r.where === 'error')) {
      const lines = text.split('\n')
      expect(lines.length, from).toBeLessThanOrEqual(2)
      for (const line of lines) {
        if ([...line].every(measured)) {
          expect(rows(line), `${from}: ${line}`).toBe(1)
          expect(exactWidth(line), `${from}: ${line}`).toBeLessThanOrEqual(LENS_BODY_TEXT_PX)
        } else {
          // A glyph outside the copied table (a user's emoji or accent): the upper bound decides.
          expect(keyNoticeWidthPx(line), `${from}: ${line}`).toBeLessThanOrEqual(LENS_BODY_TEXT_PX)
          expect([...line].length, `${from}: ${line}`).toBeLessThanOrEqual(JOB_TRAIL_WIDTH)
        }
      }
      expect(rows(text.replace(/[^\n]/gu, ch => (measured(ch) ? ch : 'W')))).toBeLessThanOrEqual(KEY_NOTICE_BODY_LINES)
    }
  })

  it('status labels, header and footers fit the 568 px status line', () => {
    for (const { text, from } of all.filter(r => r.where === 'chrome')) {
      expect(text, from).not.toContain('\n')
      expect(keyNoticeWidthPx(text), `${from}: ${text}`).toBeLessThanOrEqual(KEY_NOTICE_CHROME_PX)
      if ([...text].every(measured)) expect(wrap(text, KEY_NOTICE_CHROME_PX), text).toHaveLength(1)
    }
  })
})

describe('glyphs and house rules', { timeout: 120_000 }, () => {
  const all = ALL
  const statics = Object.values(KEY_NOTICE_COPY)

  it('no blank glyph anywhere, including from hostile user fields', () => {
    expect([...KEY_NOTICE_BLANK_GLYPHS]).toEqual(['♦', '✓', '⚠', '↻', '↺', '⌛', '⋯', '░', '▓', '⬡'])
    for (const g of KEY_NOTICE_BLANK_GLYPHS) expect(METRICS.advW[String(g.codePointAt(0))], g).toBe(0)
    for (const { text, from } of [...all, ...statics.map(text => ({ text, from: text }))]) {
      for (const g of [...KEY_NOTICE_BLANK_GLYPHS, '`']) expect(text, `${from}: ${text}`).not.toContain(g)
    }
  })

  it('every glyph the module itself writes is one the lens font draws', () => {
    const clean = all.filter(r => r.clean)
    expect(clean.length).toBeGreaterThan(3000)
    for (const { text, from } of clean) {
      for (const ch of text) if (ch !== '\n') expect(METRICS.advW[String(ch.codePointAt(0))] ?? 0, `${JSON.stringify(ch)} in ${text}`).toBeGreaterThan(0)
    }
    for (const text of statics) for (const ch of text) expect(METRICS.advW[String(ch.codePointAt(0))] ?? 0, `${JSON.stringify(ch)} in ${text}`).toBeGreaterThan(0)
  })

  it('no em dash, en dash or arrow; no sign-in wording; ASCII separator', () => {
    for (const { text, from } of [...all, ...statics.map(text => ({ text, from: text }))]) {
      expect(text, from).not.toMatch(/[—–→←↑↓⇒⇐➔➜]/u)
      expect(text, from).not.toMatch(/sign(?:ed)?[ -]?in|log ?in/i)
      expect(text, from).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u00a0\u200b-\u200f\u2028\u2029\u202f\ufeff]/u)
    }
    expect(keyStatusLabel(ctx())).toContain(' | ')
  })

  it('keyNoticeField cleans what a user typed', () => {
    expect(HOSTILE.map(keyNoticeField)).toEqual(['√ Sonnet ! fast', '◈◈◈ ? ? ? ◐ … ▒ ▒', 'line break tab', 'dash - en - done', 'zero width sep', "'tick'", '', ''])
    expect(keyNoticeField(42)).toBe('')
  })
})

describe('first-time vs compact (seen-state passed in, plan 11.1)', () => {
  const c = ctx()
  const fp = keyNoticeFingerprint(c)

  it('unseen shows the long form; seen shows only the label', () => {
    const first = keyLaneNotice(c, undefined)
    expect(first.form).toBe('first-time')
    const seen = markKeyNoticeSeen(undefined, first.fingerprint, NOW)
    expect(seen).toEqual({ [fp]: '2026-10-19T19:30:00.000Z' })
    expect(keyLaneNotice(c, seen)).toEqual({ form: 'compact', fingerprint: fp, label: '◈ Key | Sonnet 5.5 | $0.004' })
    expect(keyLaneNotice(c, {}).form).toBe('first-time')
  })

  it('re-armed when tools, egress, cap, key kind or profile change', () => {
    const seen = markKeyNoticeSeen(undefined, fp, NOW)
    expect(keyLaneNotice(ctx({ variant: 'c1-tools-off' }), markKeyNoticeSeen(undefined, keyNoticeFingerprint(ctx({ variant: 'c1-tools-off' })), NOW)).form).toBe('compact')
    for (const changed of [
      ctx({ variant: 'c1-tools-on' }), ctx({ variant: 'k3-second-opinion' }), ctx({ capUsd: 2 }), ctx({ capUsd: 1.01 }),
      ctx({ keyKind: 'anthropic' }), ctx({ profileId: 'haiku' }),
    ]) expect(keyLaneNotice(changed, seen).form, JSON.stringify(changed)).toBe('first-time')
    // Not part of identity: the model label, the answer's cost, today's spend, the clock.
    for (const same of [ctx({ modelLabel: 'Other' }), ctx({ costUsd: 9 }), ctx({ spentTodayUsd: 0.9 }), ctx({ macAwaySince: NOW })]) {
      expect(keyLaneNotice(same, seen).form).toBe('compact')
    }
  })

  it('markKeyNoticeSeen never changes its input; inherited names never count as seen', () => {
    const before: KeyNoticeSeen = Object.freeze({ other: 'x' })
    const after = markKeyNoticeSeen(before, fp, NOW)
    expect(before).toEqual({ other: 'x' })
    expect(after).toEqual({ other: 'x', [fp]: '2026-10-19T19:30:00.000Z' })
    expect(markKeyNoticeSeen(after, fp, new Date(0))[fp]).toBe('2026-10-19T19:30:00.000Z')
    const proto = keyLaneNotice({ ...c, profileId: 'constructor' }, {})
    expect(proto.form).toBe('first-time')
    expect(keyLaneNotice(c, Object.create({ [fp]: 'inherited' }) as KeyNoticeSeen).form).toBe('first-time')
  })
})

describe('zero impact: a pure module (brief rule 1)', () => {
  it('imports only the frozen P1 contract and touches no env, file, clock or timer', () => {
    const source = readFileSync(join(here, 'key-notices.ts'), 'utf8')
    const imports = [...source.matchAll(/^import\b[^\n]*from '([^']+)'/gm)].map(m => m[1])
    expect(imports).toEqual(['./key-relay-contract.js', './key-relay-contract.js'])
    expect(source).not.toMatch(/process\.|require\(|\bnew Date\(\)|Date\.now|setTimeout|setInterval|globalThis|import\(/)
  })

  it('importing it writes nothing and changes no env', async () => {
    const dataDir = process.env.COS_DATA_DIR!
    const before = readdirSync(dataDir, { recursive: true }).sort()
    const env = JSON.stringify(process.env)
    vi.resetModules()
    const fresh = await import('./key-notices.js')
    expect(typeof fresh.keyLaneNotice).toBe('function')
    expect(readdirSync(dataDir, { recursive: true }).sort()).toEqual(before)
    expect(JSON.stringify(process.env)).toBe(env)
  })
})
