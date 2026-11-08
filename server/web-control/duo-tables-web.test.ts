/**
 * Duo tables (Miles's iPhone Duo, IMG_0508 and IMG_0509): markdown tables keep words whole, the first column readable,
 * and scroll inside their own box. tableFit, sxMd and the Memories renderer run from the real files in a vm (never
 * re-implemented here); the stylesheet facts are read from the CSS. Headless Chrome renders (before and after, three
 * Duo sizes) live in operations/personal/wk45_2026/duo_tables and measured zero words broken mid-word after.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')
const APP = read('app.js')
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return src.slice(a, b)
}
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function kit() {
  const ctx: any = vm.createContext({})
  vm.runInContext(slice(APP, '  function esc(s)', '  var WORDS = [') + slice(APP, '  function sxInline(s)', '  // YOU and ASSISTANT cards') +
    ';this.tableFit = tableFit; this.sxMd = sxMd; this.esc = esc;', ctx)
  return ctx
}
const K = kit()

// IMG_0508: a two-column "Area | Change" table whose first column broke mid-word ("Toda y", "Sess ion shee t").
const AREAS = ['Today', 'Session sheet', 'Typing', 'Tap targets', 'Connection', 'Session card', 'Questions', 'Refused messages', 'Files', 'Polish']
const T2 = '| Area | Change |\n|---|---|\n' + AREAS.map(a => `| ${a} | Weather and location sit under the date at the top left, even when no meeting is next |`).join('\n')
// IMG_0509: seven columns, a long second column ("Coordination tool (claims and locks ...)").
const T7 = '| # | Item | Your other copy | Status | Gate | Owner | Blocks you |\n|---|---|---|---|---|---|---|\n' +
  '| 4 | **Coordination tool** (claims and locks for sessions that share the Mac) | Your other copy is the COORD file | Building in shadow mode | Pass its 7 test cases | Codex | No |'

describe('Duo tables: tableFit, the shared column floors', () => {
  it('IMG_0508: a first column of short labels stays on one line (no width forced), the text column keeps ten characters', () => {
    const fit = K.tableFit([['Area', 'Change']].concat(AREAS.map(a => [a, 'Weather and location sit under the date'])))
    expect(fit.key).toBe(true)
    expect(fit.tableClass).toBe('tf tf-key')
    expect(fit.cols[0]).toEqual({ min: 0, width: 0 })
    expect(fit.cols[1].min).toBe(10)
    expect(fit.width(0, true)).toBe('')
  })
  it('a long first column wraps at words inside a fixed width, never below fourteen characters', () => {
    const fit = K.tableFit([['Item', 'Owner'], ['**Coordination tool** (claims and locks for sessions that share the Mac)', 'Codex']])
    expect(fit.key).toBe(false)
    expect(fit.cols[0]).toEqual({ min: 14, width: 26 })
    expect(fit.width(0, true)).toBe('width:26ch')
    expect(fit.width(0, false), 'only the first row carries the width').toBe('')
    expect(fit.cell(0, 'x', true)).toBe('<span class="tf-min" style="min-width:14ch">x</span>')
  })
  it('the label boundary: three words and 28 characters stay a label; a fourth word or a 29th character does not', () => {
    expect(K.tableFit([['Server status line', 'x']]).key).toBe(true)
    expect(K.tableFit([['Server status line now', 'x']]).key).toBe(false)
    expect(K.tableFit([['a'.repeat(28), 'x']]).key).toBe(true)
    expect(K.tableFit([['a'.repeat(29), 'x']]).key).toBe(false)
    expect(K.tableFit([['**Bold** `code`', 'x']]).key, 'markup is not counted as words or characters').toBe(true)
    expect(K.tableFit([['Only one column']]).key, 'one column is never a label column').toBe(false)
  })
  it('a short column ("4", "No") keeps its own width; a longer one gets the ten-character floor in the first row only', () => {
    const fit = K.tableFit([['#', 'Blocks you'], ['4', 'No, nothing blocks you here']])
    expect(fit.cell(0, '4', true)).toBe('4')
    expect(fit.cell(1, 'Blocks you', true)).toBe('<span class="tf-min" style="min-width:10ch">Blocks you</span>')
    expect(fit.cell(1, 'No', false)).toBe('No')
  })
  it('only a token of 25 characters or more may break inside; markup is never touched', () => {
    const fit = K.tableFit([['a', 'b']])
    const url = 'https://www.gotcos.com/control/docs'
    expect(fit.cell(1, '<a href="' + url + '">' + url + '</a>', false)).toBe('<a href="' + url + '"><span class="tf-long">' + url + '</span></a>')
    expect(fit.cell(1, 'x'.repeat(24), false)).toBe('x'.repeat(24))
    expect(fit.cell(1, 'x'.repeat(25), false)).toBe('<span class="tf-long">' + 'x'.repeat(25) + '</span>')
  })
})

describe('Duo tables: the Sessions reader and Today’s session sheet (sxMd)', () => {
  it('IMG_0508: the table scrolls in its own box, label column marked, header carries the floors', () => {
    const html = K.sxMd(T2)
    expect(html.startsWith('<div class="sx-table tf-wrap"><table class="tf tf-key tf-grid"><thead><tr><th>Area</th>')).toBe(true)
    expect(html).toContain('<th><span class="tf-min" style="min-width:10ch">Change</span></th>')
    expect(html).toContain('<td>Today</td>')
    expect(html.match(/tf-min/g)?.length, 'one floor per column, in the header row').toBe(1)
  })
  it('IMG_0509: a long first column gets its width with the alignment kept; every other column its floor', () => {
    const html = K.sxMd('| Item | Owner |\n|:--:|--:|\n| **Coordination tool** (claims and locks for sessions that share the Mac) | Codex |')
    expect(html).toContain('<th style="text-align:center;width:26ch"><span class="tf-min" style="min-width:14ch">Item</span></th>')
    expect(html).toContain('<th style="text-align:right"><span class="tf-min" style="min-width:5ch">Owner</span></th>')
    expect(html).toContain('<td style="text-align:center"><strong>Coordination tool</strong> (claims and locks for sessions that share the Mac)</td>')
    const seven = K.sxMd(T7)
    expect(seven, 'a "#" column is a label column').toContain('<table class="tf tf-key tf-grid"><thead><tr><th>#</th>')
    expect(seven.match(/<th[^>]*><span class="tf-min" style="min-width:10ch">/g)?.length).toBe(5)
    expect(seven).toContain('<th><span class="tf-min" style="min-width:5ch">Owner</span></th>')
  })
  it('Today’s session sheet renders a session’s last reply with the same function (K.markdown is sxMd)', () => {
    expect(APP).toContain('markdown: sxMd')
    expect(read('panes/today-actions.js')).toContain('K.markdown(O.last.text')
  })
})

describe('Duo tables: Meetings notes and Memories answers use the same floors', () => {
  it('Memories: the first row is the header, floors and wrapper from tableFit', () => {
    const MEM = read('panes/memories.js')
    const ctx: any = vm.createContext({ W: { tableFit: K.tableFit }, esc: K.esc })
    vm.runInContext(slice(MEM, '  function renderMarkdown(md)', '  function parseAnswer(') + ';this.renderMarkdown = renderMarkdown;', ctx)
    const html = ctx.renderMarkdown(T2)
    expect(html.startsWith('<div class="mm-table tf-wrap"><table class="tf tf-key tf-grid"><tr><th>Area</th><th><span class="tf-min" style="min-width:10ch">Change</span></th></tr>')).toBe(true)
    expect(html).toContain('<tr><td>Session sheet</td>')
  })
  it('Meetings: the table case asks tableFit and marks every cell', () => {
    const MT = read('panes/meetings.js')
    const tcase = slice(MT, "          case 'table': {", "          case 'details': {")
    expect(tcase).toContain('W.tableFit(kv ? b.rows : [b.header].concat(b.rows))')
    expect(tcase).toContain("fit.cell(c, inline(r[c] || ''), first)")
    expect(tcase).toContain('md-table-wrap tf-wrap')
  })
})

describe('Duo tables: the stylesheet', () => {
  const CTRL = noComments(read('control.css'))
  const rule = (css: string, sel: string) => {
    const i = css.indexOf(sel + ' {')
    expect(i, sel).toBeGreaterThan(-1)
    return css.slice(i, css.indexOf('}', i))
  }
  it('cells wrap at spaces only: overflow-wrap break-word over the panes’ anywhere, which squeezed a column to one letter', () => {
    const r = rule(CTRL, 'table.tf th, table.tf td')
    expect(r).toMatch(/overflow-wrap:\s*break-word/)
    expect(r).toMatch(/word-break:\s*normal/)
    expect(rule(CTRL, 'table.tf .tf-long')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule(CTRL, 'table.tf .tf-min')).toMatch(/display:\s*block/)
  })
  it('a wide table scrolls inside its own box; the page never scrolls sideways', () => {
    const r = rule(CTRL, '.tf-wrap')
    expect(r).toMatch(/overflow-x:\s*auto/)
    expect(r).toMatch(/max-width:\s*100%/)
    expect(r).toMatch(/overscroll-behavior-x:\s*contain/)
  })
  it('the first column is held at the left edge with an opaque fill, and a label column never wraps', () => {
    const r = rule(CTRL, 'table.tf tr > :first-child')
    expect(r).toMatch(/position:\s*sticky/)
    expect(r).toMatch(/left:\s*0/)
    expect(r).toMatch(/background:\s*var\(--tf-bg/)
    expect(rule(CTRL, 'table.tf.tf-key tr > :first-child')).toMatch(/white-space:\s*nowrap/)
  })
  it('the separated border model, so a held cell keeps its own lines (a collapsed table leaves them behind)', () => {
    expect(rule(CTRL, 'table.tf-grid')).toMatch(/border-collapse:\s*separate/)
    for (const [p, sel] of [['panes/sessions.css', '.sx-table table'], ['panes/meetings.css', '.md-table'], ['panes/memories.css', '.mm-answer table']]) {
      expect(rule(noComments(read(p)), sel), p).not.toMatch(/border-collapse:\s*collapse/)
    }
    expect(rule(noComments(read('panes/meetings.css')), '.md-table')).toMatch(/border-collapse:\s*separate/)
  })
})

// ── The divider between the Sessions list and the reader (sxSplitKit), run from app.js on fake elements ──────────────
const SPLIT_SRC = slice(APP, '  var SX_SPLIT_KEY = ', '  var SX_SPLIT = null;')
function splitKit(opts: { total?: number; stored?: string | null; throwing?: boolean; now?: () => number } = {}) {
  const total = opts.total ?? 1000
  const classes = new Set<string>(), props = new Map<string, string>(), attrs = new Map<string, string>()
  const listeners = new Map<string, Array<(e: any) => void>>()
  const writes: string[] = []
  const split: any = {
    classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) }, add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    getBoundingClientRect: () => ({ width: total }),
    // The list as the stylesheet sizes it: 300 px by default, else the share clamped like the CSS clamp().
    querySelector: () => ({ getBoundingClientRect: () => {
      const s = props.get('--sx-list-share')
      return { width: classes.has('sx-sized') && s ? Math.min(total - 398, Math.max(240, parseFloat(s) / 100 * total)) : 300 }
    } }),
  }
  const captured: number[] = []
  const handle: any = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    addEventListener: (t: string, fn: any) => { (listeners.get(t) ?? listeners.set(t, []).get(t)!).push(fn) },
    removeEventListener: (t: string, fn: any) => { const l = listeners.get(t); if (l) l.splice(l.indexOf(fn) >>> 0, 1) },
    setPointerCapture: (id: number) => captured.push(id),
  }
  const buttons = [{ attrs: new Map<string, string>(), textContent: '', setAttribute(k: string, v: string) { this.attrs.set(k, v) } }]
  const storage = opts.throwing
    ? { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceededError') } }
    : { getItem: () => opts.stored ?? null, setItem: (_k: string, v: string) => { writes.push(v) } }
  let clock = 1000
  const ctx: any = vm.createContext({ JSON, Math, String, Date: { now: opts.now ?? (() => clock) },
    document: { querySelectorAll: () => ({ forEach: (f: any) => buttons.forEach(f) }) } })
  vm.runInContext(SPLIT_SRC + ';this.kit = sxSplitKit;', ctx)
  const kit = ctx.kit(split, handle, storage)
  const fire = (type: string, e: any = {}) => {
    const ev = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, shiftKey: false, type, prevented: false, preventDefault() { this.prevented = true }, ...e }
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev)
    return ev
  }
  const drag = (from: number, to: number, extra: any = {}) => { fire('pointerdown', { clientX: from, ...extra }); fire('pointermove', { clientX: to, ...extra }); fire('pointerup', { clientX: to, ...extra }) }
  return { kit, classes, props, attrs, writes, fire, drag, buttons, captured, listeners, tick: (ms: number) => { clock += ms } }
}

describe('Duo tables: the divider between the Sessions list and the reader', () => {
  it('a finger drags the list wider; the share lands in storage once, when the finger lifts', () => {
    const k = splitKit()
    k.fire('pointerdown', { clientX: 400 })
    expect(k.captured, 'the pointer is captured, so a pane never takes the drag').toEqual([1])
    expect(k.classes.has('sx-dragging')).toBe(true)
    k.fire('pointermove', { clientX: 500 })
    expect(k.props.get('--sx-list-share')).toBe('40.00%')
    expect(k.classes.has('sx-sized')).toBe(true)
    expect(k.writes, 'nothing written mid-drag').toEqual([])
    k.fire('pointerup', { clientX: 500 })
    expect(k.classes.has('sx-dragging')).toBe(false)
    expect(k.writes.map(w => JSON.parse(w))).toEqual([{ share: 40, full: false }])
    expect(k.attrs.get('aria-valuenow')).toBe('40')
    expect(k.attrs.get('aria-valuetext')).toBe('Session list 40% of the width')
  })
  it('the lift’s own position counts (a browser may fold the last moves into it); a lift that never moved is a tap', () => {
    const k = splitKit()
    k.fire('pointerdown', { clientX: 400 }); k.fire('pointermove', { clientX: 410 }); k.fire('pointerup', { clientX: 500 })
    expect(k.props.get('--sx-list-share')).toBe('40.00%')
    expect(JSON.parse(k.writes.at(-1)!)).toEqual({ share: 40, full: false })
  })
  it('both panes keep their minimums: the list 240 px, the reader 380 px past the 18 px divider', () => {
    const k = splitKit()
    k.drag(400, -5000)
    expect(k.props.get('--sx-list-share')).toBe('24.00%')
    k.drag(400, 5000)
    expect(k.props.get('--sx-list-share')).toBe('60.20%')
    expect([k.attrs.get('aria-valuemin'), k.attrs.get('aria-valuemax')]).toEqual(['24', '60'])
  })
  it('a double tap or a double click goes back to the default width; two taps far apart, a wobble or a cancel do not', () => {
    const k = splitKit()
    k.drag(400, 520)
    expect(k.classes.has('sx-sized')).toBe(true)
    k.drag(400, 402); k.tick(400); k.drag(400, 403)
    expect(k.classes.has('sx-sized'), 'a 2 px wobble is a tap, and taps 400 ms apart are two single taps').toBe(true)
    k.tick(400); k.fire('pointerdown', { clientX: 400 }); k.fire('pointercancel', { clientX: 400 }); k.tick(100); k.drag(400, 400)
    expect(k.classes.has('sx-sized'), 'a cancelled touch is not a tap').toBe(true)
    k.tick(100); k.drag(400, 400)
    expect(k.classes.has('sx-sized')).toBe(false)
    expect(k.props.has('--sx-list-share')).toBe(false)
    expect(JSON.parse(k.writes.at(-1)!)).toEqual({ share: null, full: false })
    k.drag(400, 520)
    const dbl = k.fire('dblclick')
    expect(dbl.prevented).toBe(true)
    expect(k.classes.has('sx-sized')).toBe(false)
  })
  it('a right click and another finger never move it', () => {
    const k = splitKit()
    const right = k.fire('pointerdown', { pointerType: 'mouse', button: 2, clientX: 400 })
    expect(right.prevented).toBe(false)
    k.fire('pointermove', { pointerType: 'mouse', button: 2, clientX: 600 })
    expect(k.classes.has('sx-sized')).toBe(false)
    k.fire('pointerdown', { clientX: 400 })
    k.fire('pointermove', { pointerId: 2, clientX: 600 })
    expect(k.classes.has('sx-sized'), 'a second finger is not the one dragging').toBe(false)
    k.fire('pointerup', { pointerId: 2, clientX: 600 })
    expect(k.classes.has('sx-dragging'), 'and its lift does not end the drag').toBe(true)
  })
  it('keyboard: arrows step 16 px, Shift 64, Home and End go to the limits; other keys pass through', () => {
    const k = splitKit()
    expect(k.fire('keydown', { key: 'ArrowRight' }).prevented).toBe(true)
    expect(k.props.get('--sx-list-share')).toBe('31.60%')
    k.fire('keydown', { key: 'ArrowLeft', shiftKey: true })
    expect(k.props.get('--sx-list-share')).toBe('25.20%')
    k.fire('keydown', { key: 'End' }); expect(k.props.get('--sx-list-share')).toBe('60.20%')
    k.fire('keydown', { key: 'Home' }); expect(k.props.get('--sx-list-share')).toBe('24.00%')
    expect(k.writes.length, 'each key press is kept').toBe(4)
    expect(k.fire('keydown', { key: 'Tab' }).prevented).toBe(false)
  })
  it('remembers the width and Full width on this device, and works when storage throws or holds junk', () => {
    const k = splitKit({ stored: JSON.stringify({ share: 45, full: true }) })
    expect(k.props.get('--sx-list-share')).toBe('45.00%')
    expect(k.classes.has('sx-full')).toBe(true)
    expect(k.buttons[0].textContent).toBe('Show list')
    expect(k.buttons[0].attrs.get('aria-pressed')).toBe('true')
    for (const stored of ['{not json', JSON.stringify({ share: 140 }), JSON.stringify({ share: '40' })]) {
      const j = splitKit({ stored })
      expect(j.classes.has('sx-sized'), stored).toBe(false)
    }
    const t = splitKit({ throwing: true })
    t.drag(400, 500)
    expect(t.props.get('--sx-list-share'), 'storage off: the choice lasts this visit').toBe('40.00%')
    t.kit.toggleFull()
    expect(t.classes.has('sx-full')).toBe(true)
  })
  it('Full width hides the list and Show list brings it back, with the button saying which', () => {
    const k = splitKit()
    expect(k.buttons[0].textContent).toBe('Full width')
    k.kit.toggleFull()
    expect(k.classes.has('sx-full')).toBe(true)
    expect(k.buttons[0].textContent).toBe('Show list')
    expect(JSON.parse(k.writes.at(-1)!)).toEqual({ share: null, full: true })
    k.kit.toggleFull()
    expect(k.classes.has('sx-full')).toBe(false)
    expect(APP).toContain("if (act === 'full') { if (SX_SPLIT) SX_SPLIT.toggleFull(); return; }")
    expect(APP).toContain("'</h2>' + sxFullButton() + '</div>'")
  })
  it('the page: a focusable separator between the list and the reader', () => {
    const html = read('index.html')
    const at = html.indexOf('id="sessions-list-col"'), handle = html.indexOf('id="sessions-handle"'), reader = html.indexOf('id="session-reader"')
    expect(at).toBeGreaterThan(-1)
    expect(handle).toBeGreaterThan(at)
    expect(reader).toBeGreaterThan(handle)
    const tag = /<div class="sx-handle"[^>]*>/.exec(html)![0]
    for (const a of ['role="separator"', 'aria-orientation="vertical"', 'tabindex="0"', 'aria-controls="sessions-list-col"', 'aria-label="Session list width"']) expect(tag).toContain(a)
  })
  it('the stylesheet: only where both panes show, a 44 px target on touch, no browser panning, the same limits as the script', () => {
    const SX = noComments(read('panes/sessions.css'))
    expect(SX).toMatch(/^\.sx-handle, \.sx-full-btn \{ display: none; \}/m)
    const wide = SX.slice(SX.indexOf('@media (min-width: 760px) {\n  .split.sx-split'))
    const h = wide.slice(wide.indexOf('.sx-handle {'), wide.indexOf('}', wide.indexOf('.sx-handle {')))
    expect(h).toMatch(/display:\s*flex/)
    expect(h).toMatch(/touch-action:\s*none/)
    expect(h).toMatch(/position:\s*sticky/)
    expect(wide).toMatch(/grid-template-columns:\s*minmax\(260px, 340px\) 18px minmax\(0, 1fr\)/)
    const lim = /\.split\.sx-split\.sx-sized \{ grid-template-columns: clamp\((\d+)px, var\(--sx-list-share, 30%\), calc\(100% - (\d+)px\)\) (\d+)px/.exec(wide)
    expect(lim).not.toBeNull()
    const n = (name: string) => Number(new RegExp(name + ' = (\\d+)').exec(APP)![1])
    expect(Number(lim![1])).toBe(n('SX_LIST_MIN'))
    expect(Number(lim![2])).toBe(n('SX_READER_MIN') + n('SX_HANDLE_W'))
    expect(Number(lim![3])).toBe(n('SX_HANDLE_W'))
    const coarse = /@media \(pointer: coarse\) \{ \.sx-handle::before \{[^}]*left: -(\d+)px; right: -(\d+)px; \} \}/.exec(wide)
    expect(coarse).not.toBeNull()
    expect(n('SX_HANDLE_W') + Number(coarse![1]) + Number(coarse![2])).toBeGreaterThanOrEqual(44)
    expect(wide).toMatch(/\.split\.sx-split\.sx-full\.reading \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(wide).toMatch(/\.sx-split\.sx-full\.reading > \.split-list, \.sx-split\.sx-full\.reading > \.sx-handle \{ display: none; \}/)
    expect(wide).toMatch(/\.sx-split\.sx-dragging > \.split-list, \.sx-split\.sx-dragging > \.reader \{ pointer-events: none; \}/)
  })
})
