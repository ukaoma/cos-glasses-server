/**
 * 7.0.23 (lead 23:02, from Miles's phone rows on 11/10): on the unfolded Duo, after a keyboard closed, visualViewport
 * reported a height of 0 (offset 0 to 787) for minutes, while innerHeight was back at 787 within 0.3 s. A visible
 * height under VV_MIN_PX (80) is never a reading: viewportFit returns innerHeight from offset 0, says vv false, and
 * counts it (runs and reads), and every layout report carries the counts. Work's chat box reads the visible box through
 * viewportFit too, so it never sizes or scrolls by a height of 0. These run app.js's and work.js's own text.
 * They do not show that this changes what his screen showed: only his phone can.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const WORK = readFileSync(join(HERE, 'panes/work.js'), 'utf8')

function slice(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}

// app.js's viewportFit and its VP, against a test window (no keyboard focus: the layout height is innerHeight).
function fitKit(win: any) {
  const doc: any = { documentElement: { clientHeight: win.innerHeight }, activeElement: null }
  win.__doc = doc
  const src = slice(APP, '  var VP = { layoutH: 0 };', '  // ── layout breadcrumbs')
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'Date', src + '\nreturn { fit: viewportFit, VP: VP, MIN: VV_MIN_PX };')(win, doc, Date) as {
    fit: () => any; VP: any; MIN: number }
}
function duo(vv: Record<string, number> | null, innerHeight = 787): any {
  return { innerHeight, innerWidth: 1119, visualViewport: vv ? { scale: 0.85, offsetTop: 0, ...vv } : undefined, matchMedia: () => ({ matches: true }) }
}

describe('viewportFit: a visible height under 80 px is no reading', () => {
  it('height 0 with an offset of 787 (his 20:26:28 row): innerHeight from offset 0, vv false, marked bad', () => {
    const k = fitKit(duo({ height: 0, offsetTop: 787.17 }))
    expect(k.fit()).toMatchObject({ top: 0, height: 787, inset: 0, below: 0, vv: false, bad: true })
  })
  it('under the floor but not 0 (50 px, NaN, missing): the same fallback', () => {
    for (const h of [50, 79.9, NaN, undefined as unknown as number]) {
      const k = fitKit(duo({ height: h, offsetTop: 300 }))
      expect(k.fit(), String(h)).toMatchObject({ top: 0, height: 787, vv: false, bad: true })
    }
  })
  it('a real keyboard reading (380 at 407, his kb-open rows) is used as before', () => {
    const k = fitKit(duo({ height: 380.05, offsetTop: 406.95 }))
    const v = k.fit()
    expect(v.vv).toBe(true)
    expect(v.bad).toBeUndefined()
    expect([v.top, v.height]).toEqual([407, 380])
  })
  it('the fallback is innerHeight, not the layout height kept while typing (a keyboard up, the web view 380 tall)', () => {
    const win = duo({ height: 787, offsetTop: 0 })
    const k = fitKit(win)
    k.fit()                                    // not typing: the layout height is 787
    win.__doc.activeElement = { tagName: 'TEXTAREA' }
    win.innerHeight = 380                      // the keyboard shrank the web view
    win.visualViewport!.height = 0             // and the reading is the bad one
    const v = k.fit()
    expect(v.layoutH, 'the layout height is kept while typing').toBe(787)
    expect([v.top, v.height, v.vv]).toEqual([0, 380, false])
  })
  it('the floor is 80 and 80 itself is a reading', () => {
    const k = fitKit(duo({ height: 80, offsetTop: 0 }))
    expect(k.MIN).toBe(80)
    expect(k.fit().vv).toBe(true)
  })
  it('counts runs and reads: 0, 0, 380, 0 is two runs of bad readings and three bad reads', () => {
    const win = duo({ height: 0, offsetTop: 0 })
    const k = fitKit(win)
    k.fit(); k.fit()
    win.visualViewport!.height = 380
    k.fit()
    win.visualViewport!.height = 0
    k.fit()
    expect([k.VP.badN, k.VP.badReads]).toEqual([2, 3])
  })
  it('no visualViewport at all (an old browser) is not counted as a bad reading', () => {
    const k = fitKit(duo(null))
    expect(k.fit()).toMatchObject({ vv: false, height: 787 })
    expect(k.VP.badN).toBe(0)
  })
  it('every layout report carries the counts as vz and vzr', () => {
    const lc = slice(APP, '  function layoutCrumb(event, extra) {', '\n  }\n')
    expect(lc).toContain('vz: VP.badN, vzr: VP.badReads')
  })
})

describe("Work's chat box reads the visible box through viewportFit", () => {
  // work.js's chatGrow and chatKeepInView, with the real viewportFit as W.viewportFit, and the same window.
  function workKit(vv: Record<string, number>, rects: { boxTop: number; rowBottom: number }) {
    const win: any = duo(vv)
    const scrolls: number[] = []
    win.scrollBy = (_x: number, y: number) => { scrolls.push(y) }
    const box: any = { id: 'wk-chat-text', style: {}, scrollHeight: 2000, getBoundingClientRect: () => ({ top: rects.boxTop }) }
    const row: any = { getBoundingClientRect: () => ({ bottom: rects.rowBottom }) }
    const doc: any = { activeElement: box, querySelector: () => null }
    const fit = fitKit(win).fit
    const W = { viewportFit: fit }
    const $ = (id: string) => (id === 'wk-chat-text' ? box : id === 'wk-cmp-actions' ? row : null)
    const src = slice(WORK, '  function chatGrow(box) {', '  function chatResetComposer(wid) {') + slice(WORK, '  function chatKeepInView() {', '  function chatComposerFocused() {')
    // eslint-disable-next-line no-new-func
    const k = new Function('window', 'document', 'W', '$', src + '\nreturn { grow: chatGrow, keep: chatKeepInView };')(win, doc, W, $)
    return { k, box, scrolls }
  }
  it('height 0 after a close: a box already in view is not scrolled, and the box keeps its full room', () => {
    const { k, box, scrolls } = workKit({ height: 0, offsetTop: 787.17 }, { boxTop: 500, rowBottom: 600 })
    k.keep()
    expect(scrolls, 'no scroll: the visible area is innerHeight from 0').toEqual([])
    k.grow(box)
    expect(box.style.height, '42 percent of 787, capped at 320').toBe('320px')
  })
  it('a real keyboard reading still brings the row up above the keyboard', () => {
    const { k, scrolls } = workKit({ height: 380, offsetTop: 0 }, { boxTop: 500, rowBottom: 600 })
    k.keep()
    expect(scrolls).toEqual([228])
  })
  it('work.js no longer reads visualViewport for sizes or places', () => {
    const src = slice(WORK, '  function chatGrow(box) {', '  function chatResetComposer(wid) {') + slice(WORK, '  function chatKeepInView() {', '  function chatComposerFocused() {')
    expect(src).not.toMatch(/visualViewport/)
  })
})
