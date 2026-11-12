/**
 * 7.0.30, Miles's pick A (who said what): the message reader puts his words on the right in the COS chat's gold bubble
 * and COS's on the left beside its mark, as the chat already does. Runs messages.js's own turnCards, and works the light
 * edge's contrast out from control.css's own tokens and mix, so a change to either moves the number. The rendered
 * colours and sides are measured in WebKit (W1_evidence/7030/items_check.cjs, A1).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string) => readFileSync(join(HERE, f), 'utf8')
const MSG = read('panes/messages.js'), CSS = read('control.css'), APPCSS = read('app.css')
const slice = (s: string, a: string, b: string) => { const i = s.indexOf(a), j = s.indexOf(b, i); expect(i).toBeGreaterThan(-1); expect(j).toBeGreaterThan(i); return s.slice(i, j) }
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// eslint-disable-next-line no-new-func
const turnCards = new Function('W', 'esc', 'atts', 'isUserAtt', 'stripHtml',
  slice(MSG, '  function turnCards(t, msgKey) {', '  function copyTurnText(') + '\nreturn turnCards;')(
  { md: (s: string) => '<p>' + esc(s) + '</p>', structureLensAnswer: (s: string) => s }, esc, () => [], () => true, () => '') as (t: Record<string, unknown>, key: string) => string

describe('the reader says who said what by side', () => {
  const html = turnCards({ query: 'Did Gina <agree>?\nBy Friday', text: 'Yes, she agreed.' }, 'm-1')
  it('his words come first, in the bubble, right side; COS follows beside its mark', () => {
    const you = html.indexOf('<div class="cx-said you">'), cos = html.indexOf('<div class="cx-said cos">')
    expect(you).toBe(0)
    expect(cos).toBeGreaterThan(you)
    expect(html).toContain('<div class="cx-said-bubble cx-card-body" data-hl>Did Gina &lt;agree&gt;?<br>By Friday</div>')
    expect(html.slice(cos)).toMatch(/^<div class="cx-said cos"><span class="cc-avatar" aria-hidden="true"><svg class="icon"><use href="#i-mark"\/><\/svg><\/span>/)
    expect(html).toContain('<div class="cx-card-body md" data-hl><p>Yes, she agreed.</p></div>')
  })
  it('a screen reader hears whose words, the visible "You" is not read twice, and the old cards are gone', () => {
    const said = (who: string, words: string) => { const i = html.indexOf('<span class="sr-only">' + who + ' said</span>'); expect(i, who).toBeGreaterThan(-1); expect(i).toBeLessThan(html.indexOf(words)) }
    said('You', 'Did Gina')
    said('COS', 'Yes, she agreed.')
    expect(html).toContain('<span class="cx-said-who" aria-hidden="true">You</span>')
    expect(html).not.toContain('cx-card-label')
    expect(html).not.toMatch(/class="cx-card[ "]/)
  })
  it('an empty question still draws a bubble', () => {
    expect(turnCards({ query: '  ', text: '' }, 'm-2')).toContain('data-hl>(empty query)</div>')
  })
})

// sRGB contrast of a color-mix(in srgb, A p%, B) over the page, from the stylesheets' own values.
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const lightToken = (css: string, name: string) => { const m = new RegExp(':root \\{[^}]*?--' + name + ':\\s*(#[0-9a-f]{6})').exec(css); expect(m, name).not.toBeNull(); return hex(m![1]) }

describe('his bubble\'s edge reads against the page', () => {
  it('light: the edge is opaque and at least 3:1 against the page', () => {
    const m = /:root \{ --said-edge: color-mix\(in srgb, var\(--(\w+)\) (\d+)%, var\(--(\w+)\)\); \}/.exec(CSS)
    expect(m, 'the light edge is a mix of two tokens, with no transparency').not.toBeNull()
    const tok = (n: string) => n === 'gold' ? lightToken(CSS, 'gold') : lightToken(APPCSS, n)
    const a = tok(m![1]), b = tok(m![3]), p = Number(m![2]) / 100
    const edge = a.map((v, i) => v * p + b[i] * (1 - p))
    expect(ratio(edge, lightToken(APPCSS, 'page'))).toBeGreaterThanOrEqual(3)
    expect(CSS).toContain('border: 1px solid var(--said-edge);')
  })
  it('dark keeps the chat\'s own edge, by both dark switches', () => {
    expect(CSS).toContain(":root[data-theme='dark'] { --said-edge: color-mix(in srgb, var(--gold) 45%, transparent); }")
    expect(CSS).toContain("@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { --said-edge: color-mix(in srgb, var(--gold) 45%, transparent); } }")
  })
})
