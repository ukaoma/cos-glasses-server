/**
 * F1 (Miles 2026-11-14 08:20): "On the calendar view for mobile, I think that we need a better indicator of when a
 * certain date is selected, currently it's like a light accent ... make it more of like a dark accent ... the outline for
 * the current day is fine." The picked day in Meetings' calendar is filled with the primary button's colours
 * (--accent, number and dot in --on-accent), in both themes and at every width; today keeps its ring; picked and today
 * together keep both (the fill, and a thin --on-accent line inside the ring). Contrast of the number on the fill:
 * 5.25:1 light (#ffffff on #89662d), 9.18:1 dark (#17120e on #d9b06a), measured from app.css's tokens below.
 * Pictures: F1_evidence/pictures_for_miles/mt_selected/.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const CSS = strip(readFileSync(join(HERE, 'panes/meetings.css'), 'utf8'))
const APPCSS = strip(readFileSync(join(HERE, 'app.css'), 'utf8'))
const JS = readFileSync(join(HERE, 'panes/meetings.js'), 'utf8')

/** Top-level (not inside any @media) rules: selector list -> declarations, in source order. */
function topRules(css: string): Array<{ sel: string; decls: string; at: number }> {
  const out: Array<{ sel: string; decls: string; at: number }> = []
  let i = 0, depth = 0, start = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '{') { if (depth === 0) { const sel = css.slice(start, i).trim(); const end = css.indexOf('}', i); if (!sel.startsWith('@')) { out.push({ sel, decls: css.slice(i + 1, end), at: i }); i = end + 1; start = i; continue } } depth++ }
    else if (c === '}') { depth--; if (depth === 0) start = i + 1 }
    i++
  }
  return out
}
const TOP = topRules(CSS)
const find = (sel: string) => TOP.find(r => r.sel.split(/\s*,\s*/).includes(sel))
function lum(hex: string) {
  const c = [0, 2, 4].map(i => parseInt(hex.slice(1 + i, 3 + i), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
/** The value of a custom property in the first (light) or second (dark) block that sets it. */
function token(name: string, nth: 0 | 1) { return [...APPCSS.matchAll(new RegExp('\\s' + name + ':\\s*(#[0-9a-fA-F]{6})', 'g'))][nth][1] }

describe('Meetings: the picked day is filled with the primary colours, today keeps its ring', () => {
  it('the picked day: --accent fill, --on-accent text, the primary button\'s pair, and it holds under hover', () => {
    const r = find(".mt-day[aria-pressed='true']")!
    expect(r).toBeTruthy()
    expect(r.sel).toContain(".mt-day[aria-pressed='true']:not(:disabled):hover")
    expect(r.decls).toMatch(/background:\s*var\(--accent\)/)
    expect(r.decls).toMatch(/color:\s*var\(--on-accent\)/)
    expect(r.decls).not.toMatch(/color-mix|#[0-9a-f]{3,6}/i)
    expect(APPCSS).toMatch(/\.btn\.primary\s*\{[^}]*background:\s*var\(--accent\)[^}]*color:\s*var\(--on-accent\)/)
  })
  it('its number and the meetings dot are --on-accent, and the number rule wins over the disabled grey (it comes after)', () => {
    const num = find(".mt-day[aria-pressed='true'] .mt-dnum")!, dot = find(".mt-day[aria-pressed='true'] .mt-dot.on")!
    expect(num.decls).toMatch(/color:\s*var\(--on-accent\)/)
    expect(dot.decls).toMatch(/background:\s*var\(--on-accent\)/)
    expect(num.at).toBeGreaterThan(find('.mt-day:disabled .mt-dnum')!.at)
  })
  it('today keeps its ring exactly; picked and today together keep the ring with an --on-accent line inside it', () => {
    expect(find('.mt-day.mt-today')!.decls).toMatch(/box-shadow:\s*inset 0 0 0 1\.5px var\(--accent\)/)
    expect(find(".mt-day.mt-today[aria-pressed='true']")!.decls).toMatch(/box-shadow:\s*inset 0 0 0 1\.5px var\(--accent\),\s*inset 0 0 0 3px var\(--on-accent\)/)
  })
  it('the focus ring on the fill is --on-accent (an --accent ring would vanish)', () => {
    expect(find(".mt-day[aria-pressed='true']:focus-visible")!.decls).toMatch(/outline-color:\s*var\(--on-accent\)/)
  })
  it('the same at every width: no media block restyles the picked day', () => {
    const inMedia = CSS.replace(/^[\s\S]*?(?=@media)/, '')
    const blocks = [...inMedia.matchAll(/@media[^{]*\{([\s\S]*?\n\})/g)].map(m => m[1])
    for (const b of blocks) expect(b).not.toContain("aria-pressed='true'")
  })
  it('no size, spacing or grid change: the picked-day rules set colours and rings only', () => {
    for (const r of TOP.filter(x => x.sel.includes("aria-pressed='true'"))) expect(r.decls).not.toMatch(/min-height|padding|margin|width|height|gap|grid|font-size|border:/)
  })
  it('contrast of the number on the fill is 4.5:1 or better in both themes (measured: 5.25 light, 9.18 dark)', () => {
    const light = ratio(token('--on-accent', 0), token('--accent', 0)), dark = ratio(token('--on-accent', 1), token('--accent', 1))
    expect(light).toBeGreaterThanOrEqual(4.5); expect(dark).toBeGreaterThanOrEqual(4.5)
    expect(Number(light.toFixed(2))).toBe(5.25); expect(Number(dark.toFixed(2))).toBe(9.18)
  })
  it('not colour alone: the picked day carries aria-pressed and today aria-current="date" (meetings.js)', () => {
    expect(JS).toMatch(/class="mt-day' \+ \(isToday \? ' mt-today' : ''\) \+ '" data-mt="day" data-day="' \+ key \+ '" aria-pressed="' \+ on \+ '"' \+ \(isToday \? ' aria-current="date"' : ''\)/)
  })
})
