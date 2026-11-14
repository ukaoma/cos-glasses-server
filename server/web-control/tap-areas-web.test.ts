/**
 * F1 Set D (Miles 2026-11-14, "Yes, build it"): on a touch screen the small text controls the 44 px floor does not reach
 * get 44 px of tap height, and their look does not change.
 *  - Tab words (.cx-switch), All messages and Mark all read, Work's text buttons and Mentioned: an invisible layer
 *    (::before), at least 44 px tall, centred on the control.
 *  - Work's stage menu (a select takes no layer): the box is 44 px with a transparent top and bottom border, pulled back by
 *    the same negative margin, so its row keeps its height; its edge is drawn inside (inset shadow).
 *  - A Work card's foot is at least 44 px inside, because the card clips (overflow hidden): a layer reaching above the
 *    foot would take taps meant to open the card.
 * The chat's quote rows are not in this change (they would add 263 px to the feed; Miles has no picture of it).
 * A source test cannot see a hit area: the proof is the WebKit measurement (F1_evidence/setd.cjs, tap height hit-tested
 * out from each control's centre, and a pixel diff of each control's own box) and the FAST layout sweep (covered check).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const APP = strip(readFileSync(join(HERE, 'app.css'), 'utf8'))
const CHAT = strip(readFileSync(join(HERE, 'panes/cos-chat.css'), 'utf8'))
const WORK = strip(readFileSync(join(HERE, 'panes/work.css'), 'utf8'))

/** Every `@media <query> { ... }` block body, in source order, by brace matching. */
function mediaBlocks(src: string, query: string): Array<{ at: number; body: string }> {
  const out: Array<{ at: number; body: string }> = []
  let from = 0
  for (;;) {
    const at = src.indexOf('@media ' + query + ' {', from); if (at < 0) return out
    let i = src.indexOf('{', at), depth = 0; const start = i + 1
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break }
    out.push({ at, body: src.slice(start, i) }); from = i
  }
}
/** The declarations of the first rule whose selector list is exactly `sel` inside `css` (and, given `has`, contains it). */
function rule(css: string, sel: string, has = ''): string {
  const re = new RegExp('(^|[}\\s])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  for (const m of css.matchAll(re)) if (m[2].includes(has)) return m[2]
  return ''
}
const coarse = (src: string, has: string) => mediaBlocks(src, '(any-pointer: coarse)').find(b => b.body.includes(has))
/** A centred hit layer of at least 44 px: absolute, top 50 %, height max(44px, ...), translateY(-50%). */
function centredLayer(decl: string) {
  expect(decl).toMatch(/content:\s*''/)
  expect(decl).toMatch(/position:\s*absolute/)
  expect(decl).toMatch(/top:\s*50%/)
  expect(decl).toMatch(/height:\s*max\(44px,/)
  expect(decl).toMatch(/transform:\s*translateY\(-50%\)/)
}

describe('Set D: tab words keep their look and take 44 px of tap height', () => {
  it('the switch layer is centred and at least 44 px tall (27 px words gave 41 px before)', () => {
    const b = coarse(APP, '.cx-switch button::before')
    expect(b).toBeTruthy()
    const d = rule(b!.body, '.cx-switch button::before')
    centredLayer(d)
    expect(d).toMatch(/height:\s*max\(44px,\s*calc\(100% \+ 14px\)\)/)
    expect(d).not.toMatch(/inset:/)
  })
})

describe('Set D: All messages and Mark all read', () => {
  it('on touch the 36 px links carry a centred 44 px layer and are its containing block', () => {
    const b = coarse(CHAT, '.cc-head-acts .link-btn::before')
    expect(b).toBeTruthy()
    expect(rule(b!.body, '.cc-head-acts .link-btn')).toMatch(/position:\s*relative/)
    centredLayer(rule(b!.body, '.cc-head-acts .link-btn::before'))
  })
  it('the visible link keeps 36 px (the row does not grow)', () => {
    expect(rule(CHAT, '.cc-head-acts .link-btn')).toMatch(/min-height:\s*36px/)
    const b = coarse(CHAT, '.cc-head-acts .link-btn::before')!
    expect(rule(b.body, '.cc-head-acts .link-btn')).not.toMatch(/min-height/)
  })
})

describe('Set D: Work text buttons, Mentioned, the stage menu and the card foot', () => {
  const b = coarse(WORK, '.wk-stage {')
  it('one touch block, after every base .wk-stage rule so it wins on order', () => {
    expect(b).toBeTruthy()
    const lastBase = Math.max(WORK.lastIndexOf('.wk-stage { min-height: 36px'), WORK.lastIndexOf('.wk-stage-lg { min-height: 32px'))
    expect(lastBase).toBeGreaterThan(0)
    expect(b!.at).toBeGreaterThan(lastBase)
  })
  it('text buttons and Mentioned: relative, with a centred 44 px layer', () => {
    expect(rule(b!.body, '.wk-text-btn, .wk-menu-label')).toMatch(/position:\s*relative/)
    centredLayer(rule(b!.body, '.wk-text-btn::before, .wk-menu-label::before'))
  })
  it('the card foot is at least 44 px inside its 1 px top rule, so the layer is not cut by the card edge', () => {
    expect(rule(WORK, '.wk-card')).toMatch(/overflow:\s*hidden/)
    expect(rule(WORK, '.wk-card-foot')).toMatch(/border-top:\s*1px/)
    expect(rule(b!.body, '.wk-card-foot')).toMatch(/min-height:\s*45px/)
  })
  it('the stage menu: 44 px box, transparent top and bottom border, the same negative margin, edge drawn inside', () => {
    const d = rule(b!.body, '.wk-stage')
    expect(d).toMatch(/--wk-tap:\s*max\(0px,\s*calc\(\(44px - var\(--wk-stage-h\)\) \/ 2\)\)/)
    expect(d).toMatch(/min-height:\s*44px/)
    expect(d).toMatch(/margin-block:\s*calc\(-1 \* var\(--wk-tap\)\)/)
    expect(d).toMatch(/border:\s*solid transparent/)
    expect(d).toMatch(/border-width:\s*var\(--wk-tap\) 0/)
    expect(d).toMatch(/background-clip:\s*padding-box/)
    expect(d).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--panel-border\)/)
    expect(d).toMatch(/border-radius:\s*7px \/ calc\(7px \+ var\(--wk-tap\)\)/)
  })
  it('every base stage-menu height declares the same --wk-stage-h, so the box keeps that visible height and its row', () => {
    const bases = [rule(WORK, '.wk-stage', 'min-height'), rule(WORK, '.wk-stage-lg', 'min-height')]
    const m599 = mediaBlocks(WORK, '(max-width: 599px)').find(x => x.body.includes('.wk-stage {'))
    expect(m599).toBeTruthy(); bases.push(rule(m599!.body, '.wk-stage'))
    for (const d of bases) {
      const mh = d.match(/min-height:\s*(\d+)px/), v = d.match(/--wk-stage-h:\s*(\d+)px/)
      expect(mh && v).toBeTruthy()
      expect(v![1]).toBe(mh![1])
      // the chevrons: --wk-chev-y is the base rule's own y, and the touch rule moves them 1 px for the edge now drawn inside
      const pos = d.match(/background-position:\s*calc\(100% - 13px\) (\d+)px/), cy = d.match(/--wk-chev-y:\s*(\d+)px/)
      expect(pos && cy).toBeTruthy()
      expect(cy![1]).toBe(pos![1])
      // the arithmetic: the transparent border makes the box 44 tall, the margin takes the same back out of the row
      const tap = Math.max(0, (44 - Number(v![1])) / 2)
      expect(Number(v![1]) + 2 * tap).toBe(44)
    }
    expect(rule(b!.body, '.wk-stage')).toMatch(/background-position:\s*calc\(100% - 14px\) calc\(var\(--wk-chev-y\) \+ 1px\), calc\(100% - 10px\) calc\(var\(--wk-chev-y\) \+ 1px\)/)
  })
  it('a focused stage menu draws its ring at the visible edge, not around the 44 px box', () => {
    expect(rule(b!.body, '.wk-stage:focus-visible')).toMatch(/outline-offset:\s*calc\(-1 \* var\(--wk-tap\)\)/)
  })
})
