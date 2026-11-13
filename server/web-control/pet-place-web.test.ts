/**
 * 7.0.33 A13 (Anand round 2, slide 9; Miles: "I'll add a toolbar option as well"): the pet shows on Today (as before),
 * small in the top bar on a phone, or not at all. Runs the shipped petPrefs and petInBar, cut from app.js. Renders:
 * W1_evidence/7033/visual (before_ and after_A13_*).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8'), SET = readFileSync(join(HERE, 'panes/settings.js'), 'utf8')
const cut = (a: string, b: string) => { const i = APP.indexOf(a), j = APP.indexOf(b, i); if (i < 0 || j < 0) throw new Error('cut ' + a); return APP.slice(i, j) }
function kit(stored: unknown, wide: boolean, rail = false) {
  const src = cut('  function petPrefs() {', '  function setPetPrefs(') + cut('  function petInBar()', '  function placePet()')
  // eslint-disable-next-line no-new-func
  return new Function('deps', `with (deps) {\n${src}\nreturn { petPrefs, petInBar };\n}`)({ readStore: () => stored, PET_KEY: 'cos-web-pet', PET_BAR_MQ: { matches: wide }, sideRail: () => rail })
}
describe('where the pet shows (Anand\'s mock, slide 9; Miles 12:43)', () => {
  it('a browser that never chose keeps it on Today, as before', () => {
    expect(kit({}, false).petPrefs()).toEqual({ pet: 'mac', show: true, place: 'today' })
    expect(kit({}, false).petInBar()).toBe(false)
  })
  it('"Small, in the top bar": in the bar under 600 px, on Today from 600 px', () => {
    expect(kit({ show: true, place: 'bar' }, false).petInBar()).toBe(true)
    expect(kit({ show: true, place: 'bar' }, true).petInBar()).toBe(false)
  })
  it('the folded Duo (side rail) keeps it on Today until its place there is chosen (lead 12:43)', () => {
    expect(kit({ show: true, place: 'bar' }, false, true).petInBar()).toBe(false)
  })
  it('Off wins over the place; a stray value reads as Today', () => {
    expect(kit({ show: false, place: 'bar' }, false).petInBar()).toBe(false)
    expect(kit({ place: 'sideways' }, false).petPrefs().place).toBe('today')
  })
  it('Settings offers the three, in the choice rows Character uses (no switch, no pill tabs)', () => {
    for (const [v, name] of [['today', 'On Today'], ['bar', 'In the top bar'], ['off', 'Off']]) expect(SET).toContain(`placeRow('${v}', '${name}'`)
    expect(APP).toContain("toast('Pet hidden. Turn it back on in Settings, Pet.')")
    expect(APP).toContain("var PET_IDLE_LINE = 'I\\u2019ll wave when an agent starts.';")
    expect(SET).toContain('class="cx-set-row cx-set-choice" data-set="pet-place"')
    expect(SET).not.toContain('data-set="pet-show"')
  })
})
