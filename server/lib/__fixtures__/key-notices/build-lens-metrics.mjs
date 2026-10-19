#!/usr/bin/env node
// Builds lens-metrics-pretext-0.1.4.json for server/lib/key-notices.test.ts (plan v4 14.2 row P8).
//
// The server has no dependency on `@evenrealities/pretext`; the app does (pinned 0.1.4 at
// cos-glasses-app f02fab64, `src/lib/lens-text.ts`, `lens-drawable.ts`). This copies, READ ONLY,
// the part of Even's LVGL font metrics the key notices can draw: the pixel advance of every
// printable ASCII glyph plus the few symbols the notices use, the kerned advance of every ordered
// pair of those glyphs where kerning changes it, and which code points the font carries.
// The test replays pretext's own `measureTextWrap` on this table, so a line count here is the
// line count the app's `countLensLines` gives.
//
// Usage: node build-lens-metrics.mjs <path to @evenrealities/pretext/dist/font_measure.js>
// Fixture only: under server/lib/__fixtures__/, which the npm package excludes.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const src = process.argv[2]
if (!src) throw new Error('usage: build-lens-metrics.mjs <font_measure.js>')
const pkg = JSON.parse(readFileSync(join(dirname(src), '..', 'package.json'), 'utf8'))
if (pkg.name !== '@evenrealities/pretext' || pkg.version !== '0.1.4') throw new Error(`expected @evenrealities/pretext 0.1.4, got ${pkg.name} ${pkg.version}`)
const P = await import(pathToFileURL(src).href)

// What a key notice may draw: printable ASCII, the label mark, the fit ellipsis, and the drawn
// look-alikes key-notices.ts substitutes for the blank glyphs.
const SYMBOLS = ['◈', '…', '·', '√', '×', '◐', '▒', '?']
const BLANK = ['♦', '✓', '⚠', '↻', '↺', '⌛', '⋯', '░', '▓', '⬡']
const chars = []
for (let cp = 0x20; cp <= 0x7e; cp++) chars.push(String.fromCodePoint(cp))
for (const s of SYMBOLS) if (!chars.includes(s)) chars.push(s)

// pretext: getTextWidth(ab) = advPx(a, next=b) + advPx(b, next=none), so advPx(a|b) = w(ab) - w(b).
const adv = {}
const pairs = {}
for (const a of chars) adv[a.codePointAt(0)] = P.getTextWidth(a)
for (const a of chars) for (const b of chars) {
  const px = P.getTextWidth(a + b) - P.getTextWidth(b)
  if (px !== adv[a.codePointAt(0)]) pairs[`${a.codePointAt(0)},${b.codePointAt(0)}`] = px
}
const advW = {}
for (const ch of [...chars, ...BLANK]) advW[ch.codePointAt(0)] = P.getAdvW(ch.codePointAt(0))

// Fidelity checks: Even's own wrap of lines that do and do not fit, which the test's replay of
// measureTextWrap on this table must reproduce exactly.
const samples = [
  'Your key, not your plan', 'Meetings stay on the Mac unless a tool reads one.',
  "Today's $1000.00 cap on this key is used. Resets 12:30 AM.", '◈ Key | Sonnet 5.5 | $0.004',
  'A Claude settings file sets ANTHROPIC_DEFAULT_SONNET_MODEL. Remove it to use a key.',
  'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 'a-b-c '.repeat(30),
  'Key profile @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ is off. Pick a model.\nsecond line …',
]
const checks = samples.map(text => ({ text, width: 548, lineWidths: P.measureTextWrap(text, 548).lineWidths }))

const out = {
  source: `@evenrealities/pretext ${pkg.version} dist/font_measure.js sha256 ${createHash('sha256').update(readFileSync(src)).digest('hex')}`,
  note: 'adv: pixel advance with no following glyph. pairs: "a,b" -> pixel advance of a when b follows (only where kerning changes it). advW: raw 1/16 px advance, 0 = the font has no glyph (drawn as 4 px of nothing).',
  adv, pairs, advW, checks,
}
const target = join(dirname(fileURLToPath(import.meta.url)), 'lens-metrics-pretext-0.1.4.json')
writeFileSync(target, JSON.stringify(out) + '\n')
console.log(`wrote ${target}: ${Object.keys(adv).length} glyphs, ${Object.keys(pairs).length} kerned pairs`)
