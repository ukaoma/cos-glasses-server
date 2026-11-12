/**
 * 7.0.30 item 1 (Anand on the 11-12 HC call; Miles's pick; the lead's 10:18 brief): Back follows the path the person
 * took. Runs app.js's own parseRoute, go, the "Back by path" block, isTabRoute and goBack against a fake browser history
 * (entries with an address and a state; pushState, replaceState, back; a hash change pushes an entry and runs route;
 * location.replace replaces the current one). The browser check is W1_evidence/two_column/back_path_check.cjs.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const cut = (a: string, b: string) => { const i = APP.indexOf(a), j = APP.indexOf(b, i); expect(i, a).toBeGreaterThan(-1); expect(j, b).toBeGreaterThan(i); return APP.slice(i, j) }
const SRC = [
  cut('  function esc(s) {', '  // Agent turns and task text'),
  cut('  var ROOT_PANES = [', '\n'),
  cut('  var TITLES = {', '\n'),
  cut('  function parseRoute() {', '  // 7.0.2 (A8)'),
  cut('  function isTabRoute(args) {', '\n'),
  cut('  // Back (7.0.30): the way he came', '  // \'#/<pane>/t/<tab>\''),
].join('\n')

type Entry = { hash: string; state: any }
function browser(start: string, o: { panes?: Record<string, any>; document?: any } = {}) {
  const entries: Entry[] = [{ hash: start, state: null }]
  let i = 0
  const routes: string[] = []
  const history: any = {
    get length() { return entries.length },
    get state() { return entries[i]!.state },
    pushState(st: any) { entries.splice(i + 1); entries.push({ hash: entries[i]!.hash, state: st }); i++ },
    replaceState(st: any) { entries[i]!.state = st },
    back() { if (i === 0) return; const was = entries[i]!.hash; i--; if (entries[i]!.hash !== was) k.route() },
    go(n: number) { const to = Math.max(0, Math.min(entries.length - 1, i + n)); if (to === i) return; const was = entries[i]!.hash; i = to; if (entries[i]!.hash !== was) k.route() },
  }
  const location: any = {
    pathname: '/control/', search: '',
    get hash() { return entries[i]!.hash },
    set hash(h: string) { if (h === entries[i]!.hash) return; entries.splice(i + 1); entries.push({ hash: h, state: null }); i++; k.route() },
    replace(url: string) { const h = url.slice(url.indexOf('#')); const was = entries[i]!.hash; entries[i] = { hash: h, state: null }; if (h !== was) k.route() },
  }
  const deps: any = { history, location, PANES: o.panes || {}, crumbDetail: '', document: o.document }
  // eslint-disable-next-line no-new-func
  const k: any = new Function('deps', `with (deps) {\n${SRC}\nfunction route() { navStamp(); deps.routes.push(location.hash) }\nreturn { route, go, goBack, navBackTo, navStamp, NAV, TITLES, navLabel, navTrail, trailName, trailCut, paintTrail };\n}`)(Object.assign(deps, { routes }))
  k.route()   // the first page
  return { k, deps, entries, get i() { return i }, history, location, routes, link: (h: string) => { location.hash = h }, name: (t: string) => { deps.crumbDetail = t; k.navLabel(t) } }
}

describe('Back goes the way he came', () => {
  it('the case that must pass: Speakers, a meeting to review, Open meeting, Back lands on Speakers (the review page), then the Speakers list', () => {
    const b = browser('#/speakers')
    b.link('#/speakers/review/m1')
    b.link('#/meetings/quilt/2026-11/m1.md')
    expect(b.k.navBackTo()).toEqual({ pane: 'speakers', path: true })
    const len = b.entries.length
    b.k.goBack()
    expect(b.location.hash).toBe('#/speakers/review/m1')
    expect(b.entries.length, 'Back adds no entry').toBe(len)
    b.k.goBack()
    expect(b.location.hash).toBe('#/speakers')
  })
  it('agrees with the system Back: our Back lands where the browser\'s Back would, and the browser\'s Forward undoes it', () => {
    const b = browser('#/today')
    b.link('#/sessions'); b.link('#/sessions/claude/abc')
    b.k.goBack()
    expect(b.i).toBe(1)
    expect(b.entries[2]!.hash, 'the reader is still Forward from here').toBe('#/sessions/claude/abc')
  })
})

describe('with no path known: the parent chain, replacing the entry', () => {
  const MEET = { up: (args: string[]) => (args.length > 2 ? args.slice(0, 2) : null) }
  it('a deep link (the first page): Back goes to the parent and adds no entry', () => {
    const b = browser('#/meetings/quilt/2026-11/m1.md')
    expect(b.k.navBackTo()).toEqual({ pane: 'meetings', path: false })
    b.k.goBack()
    expect(b.location.hash).toBe('#/meetings')
    expect(b.entries.map(e => e.hash), 'replaced, not added').toEqual(['#/meetings'])
  })
  it('a pane that names its step up keeps it (an archive chat goes back to its day)', () => {
    const b = browser('#/messages/a/2026-11-10/x', { panes: { messages: { up: (a: string[]) => (a[0] === 'a' && a.length > 2 ? a.slice(0, 2) : null) } } })
    b.k.goBack()
    expect(b.location.hash).toBe('#/messages/a/2026-11-10')
  })
  it('a reload: entries marked by an earlier load of the page give no path, so Back is the parent chain', () => {
    const b = browser('#/speakers')
    b.link('#/meetings/quilt/2026-11/m1.md')
    b.entries[b.i]!.state = { cosNav: { doc: 'an-earlier-load', pos: 1, back: '#/speakers' } }   // as a reload finds it
    b.k.NAV.last = null
    b.k.route()
    expect(b.k.navBackTo().path).toBe(false)
    b.k.goBack()
    expect(b.location.hash).toBe('#/meetings')
    expect(b.entries.length).toBe(2)
  })
  it('an overlay entry left behind (Today\'s sheet, the image viewer): Back never steps into it', () => {
    const b = browser('#/today')
    b.history.pushState({ cosTodayOverlay: 1, kind: 'need', key: 'x' })
    b.link('#/sessions/claude/abc')
    expect(b.k.navBackTo().path, 'the entry behind is the sheet, not an address').toBe(false)
    b.k.goBack()
    expect(b.location.hash).toBe('#/sessions')
    expect(b.entries[1]!.state.cosTodayOverlay, 'the sheet\'s entry is untouched').toBe(1)
  })
  it('on an overlay\'s own entry (the image viewer open over a reader) Back is not history.back', () => {
    const b = browser('#/today')
    b.link('#/sessions/claude/abc')
    b.history.pushState(Object.assign({}, b.history.state, { cosImageViewer: 1 }))
    expect(b.k.navBackTo().path).toBe(false)
  })
  it('never loops: Back from a deep link, then the browser\'s Back, never returns to the reader', () => {
    const b = browser('#/sessions/claude/abc')
    b.k.goBack()
    b.history.back()
    expect(b.entries.filter(e => e.hash === '#/sessions/claude/abc')).toHaveLength(0)
    expect(b.location.hash).toBe('#/sessions')
  })
})

describe('the label names where Back goes', () => {
  it('the way he came, or the parent', () => {
    const b = browser('#/speakers')
    b.link('#/meetings/quilt/2026-11/m1.md')
    expect(b.k.TITLES[b.k.navBackTo().pane]).toBe('Speakers')
    const d = browser('#/meetings/quilt/2026-11/m1.md')
    expect(d.k.TITLES[d.k.navBackTo().pane]).toBe('Meetings')
  })
  it('route sets the top bar\'s label and the rail Back\'s name from it', () => {
    expect(APP).toContain("$('topbar-back-label').textContent = TITLES[backTo.pane] || 'Back';")
    expect(APP).toContain("railBack.setAttribute('aria-label', 'Back to ' + (TITLES[backTo.pane] || 'the list'));")
  })
  it('every Back says where it goes: the top bar\'s word, the rail\'s name, and from 600 px the navigation bar\'s name and tooltip', () => {
    // Runs route()'s own naming lines (7.0.30 counted run: B1 and B2 failed at the open Duo, where Back is #nav-back).
    const NAMING = cut('    // 7.0.30: Back names where it goes, the way he came or the parent (navBackTo).', "    $('section-name').textContent")
    const el = () => { const a: Record<string, string> = {}; return { textContent: '', attrs: a, setAttribute: (k: string, v: string) => { a[k] = v } } }
    const els: Record<string, any> = { 'topbar-back-label': el(), 'nav-back': el() }
    const railBack = el()
    for (const [pane, title] of [['speakers', 'Speakers'], ['meetings', 'Meetings']]) {
      // eslint-disable-next-line no-new-func
      new Function('$', 'navBackTo', 'TITLES', 'r', 'railBack', NAMING)((id: string) => els[id] || null, () => ({ pane }), { speakers: 'Speakers', meetings: 'Meetings' }, { pane: 'meetings' }, railBack)
      expect(els['topbar-back-label'].textContent).toBe(title)
      expect(railBack.attrs['aria-label']).toBe('Back to ' + title)
      expect(els['nav-back'].attrs['aria-label']).toBe('Back to ' + title)
      expect(els['nav-back'].attrs.title).toBe('Back to ' + title)
    }
  })
})

describe('Back stays in reach on a tall phone', () => {
  const SCROLL = cut('  var lastY = 0;\n  function onScroll() {', '  function openMenu()')
  function bar(onReader: boolean) {
    const cls = new Set<string>(), win: any = { scrollY: 0 }
    const els: any = { topbar: { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)), add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) } },
      'topbar-back': { classList: { contains: (c: string) => c === 'hidden' && !onReader } } }
    // eslint-disable-next-line no-new-func
    const f = new Function('deps', `with (deps) {\n${SCROLL}\nreturn onScroll;\n}`)({ window: win, $: (id: string) => els[id], isPhone: () => true })
    return { scroll: (y: number) => { win.scrollY = y; f() }, tucked: () => cls.has('tucked') }
  }
  it('on a list the top bar tucks away while scrolling down, as before', () => {
    const b = bar(false); b.scroll(100); b.scroll(400)
    expect(b.tucked()).toBe(true)
  })
  it('on a reader it never tucks, so Back is always there', () => {
    const b = bar(true); b.scroll(100); b.scroll(400); b.scroll(900)
    expect(b.tucked()).toBe(false)
  })
})

// 7.0.30, Miles's pick B: the trail row reads the same marks as Back. Each step is the browser's own Back by that many
// steps; the last step is always where Back goes. The browser check is W1_evidence/7030/items_check.cjs (T1 to T4).
describe('the trail row: how he got here, from Back\'s own marks', () => {
  const fakeDoc = () => { const el: any = { hidden: true, innerHTML: '', clientWidth: 0, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {} } }; return { el, doc: { getElementById: (id: string) => (id === 'nav-trail' ? el : null) } } }
  it('Anand\'s case: Today, Speakers, a review, Open meeting reads "Today / Speakers / Naming voices / Meeting"', () => {
    const f = fakeDoc(), b = browser('#/today', { document: f.doc })
    b.link('#/speakers'); b.link('#/speakers/review/m1'); b.name('Pricing review with Gina')
    b.link('#/meetings/quilt/2026-11/m1.md'); b.name('Pricing review with Gina')
    const t = b.k.navTrail()
    expect(t.map((s: any) => s.label)).toEqual(['Today', 'Speakers', 'Naming voices'])
    expect(t.map((s: any) => s.back)).toEqual([3, 2, 1])
    expect(t[t.length - 1].hash, 'the last step is where Back goes').toBe(b.entries[b.i]!.state.cosNav.back)
    b.k.paintTrail()
    expect(f.el.hidden).toBe(false)
    const steps = [...f.el.innerHTML.matchAll(/<a href="([^"]+)" data-trail-back="(\d+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2], m[3]])
    expect(steps).toEqual([['#/today', '3', 'Today'], ['#/speakers', '2', 'Speakers'], ['#/speakers/review/m1', '1', 'Naming voices']])
    expect(f.el.innerHTML).toMatch(/<li class="trail-here" aria-current="page"><span>Meeting<\/span><\/li><\/ol>$/)
  })
  it('a step goes back that many entries in the browser\'s own history, so it lands where Back would and adds no entry', () => {
    const b = browser('#/today')
    b.link('#/speakers'); b.link('#/speakers/review/m1'); b.link('#/meetings/quilt/2026-11/m1.md')
    const len = b.entries.length
    b.history.go(-2)
    expect(b.location.hash).toBe('#/speakers')
    expect(b.entries.length).toBe(len)
    expect(b.k.navTrail().map((s: any) => s.label), 'that page keeps its own trail').toEqual(['Today'])
  })
  it('no row with no path: a deep link, a reload, a pane\'s list, or an overlay', () => {
    const f = fakeDoc(), deep = browser('#/meetings/quilt/2026-11/m1.md', { document: f.doc })
    expect(deep.k.navTrail()).toBeNull()
    deep.k.paintTrail(); expect(f.el.hidden).toBe(true)
    const g = fakeDoc(), list = browser('#/today', { document: g.doc })
    list.link('#/messages')
    expect(list.k.navTrail(), 'a list has a path').not.toBeNull()
    list.k.paintTrail(); expect(g.el.hidden, 'but no row on a pane\'s list').toBe(true)
    const r = browser('#/speakers')
    r.link('#/meetings/quilt/2026-11/m1.md')
    r.entries[r.i]!.state = { cosNav: { doc: 'an-earlier-load', pos: 1, back: '#/speakers', trail: [{ h: '#/speakers', t: '' }] } }
    r.k.NAV.last = null; r.k.route()
    expect(r.k.navTrail(), 'a reload').toBeNull()
    const o = browser('#/today')
    o.link('#/sessions/claude/abc')
    expect(o.k.navTrail()).not.toBeNull()
    o.history.pushState(Object.assign({}, o.history.state, { cosImageViewer: 1 }))   // as reader-media.js opens the viewer: the mark comes along
    expect(o.k.navTrail(), 'the image viewer\'s entry').toBeNull()
  })
  it('a message keeps its own name; the stored trail stops at 12 steps', () => {
    const b = browser('#/messages')
    b.link('#/messages/m/k1'); b.name('Message #412')
    b.link('#/sessions/claude/abc')
    expect(b.k.navTrail().map((s: any) => s.label)).toEqual(['Messages', 'Message #412'])
    for (let n = 0; n < 20; n++) b.link('#/messages/m/k' + n)
    expect(b.entries[b.i]!.state.cosNav.trail.length).toBe(12)
  })
})

describe('the trail shortens from the middle, never wrapping', () => {
  it('fits: nothing leaves', () => { const b = browser('#/today'); expect(b.k.trailCut([50, 80, 90, 60], 20, 300)).toEqual([]) })
  it('too wide: the step after the first leaves, then the next; the first, the one before this page, and this page stay', () => {
    const b = browser('#/today')
    // steps 0..4, then this page (5); "…" adds 20
    expect(b.k.trailCut([60, 70, 80, 90, 100, 60], 20, 420)).toEqual([1])
    expect(b.k.trailCut([60, 70, 80, 90, 100, 60], 20, 330)).toEqual([1, 2])
    expect(b.k.trailCut([60, 70, 80, 90, 100, 60], 20, 100)).toEqual([1, 2, 3])
  })
})
