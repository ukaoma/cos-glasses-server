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
