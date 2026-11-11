/**
 * Duo tables, part two (Miles: "use [column resize] throughout the COS, especially on the web"): the divider between a
 * list and its reader is ONE kit in app.js (splitKit), used by Sessions (sxSplitKit, unchanged; duo-tables-web.test.ts)
 * and, through W.splitKit, by Memories (760 px and up) and Messages with the COS chat (860 px and up). The kit runs here
 * from the real app.js on fake elements; the panes' options, markup and stylesheet facts are read from their files.
 * The same kit sizes the column on the right where a reader sits beside a side panel: a meeting's Ask panel (860 px and
 * up, saved and live) and a Work card's side panel (900 px and up). Threads, Speakers, Settings and Today never show two
 * such columns, so they have no divider.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')
const APP = read('app.js')
const MEM = read('panes/memories.js')
const MSG = read('panes/messages.js')
const MTG = read('panes/meetings.js')
const WRK = read('panes/work.js')
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return src.slice(a, b)
}
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
// The kit, the Sessions wrapper, mount, and the page-wide listeners (resize, Full width clicks), as app.js has them.
const KIT_SRC = slice(APP, '  function esc(s)', '  var WORDS = [') + slice(APP, '  var SX_SPLIT_KEY = ', '  // ── Sessions: read, send')
// A pane's SPLIT options object, read from its source (never re-typed here).
const paneOpts = (src: string, name = 'SPLIT'): any => {
  const m = new RegExp('var ' + name + ' = (\\{[^\\n]*\\});').exec(src)
  expect(m, 'SPLIT options').not.toBeNull()
  return vm.runInNewContext('(' + m![1] + ')')
}
const MEM_OPTS = paneOpts(MEM), MSG_OPTS = paneOpts(MSG), MTG_OPTS = paneOpts(MTG), WRK_OPTS = paneOpts(WRK, 'DIVIDER')

type Opts = { total?: number; stored?: Record<string, string>; throwing?: boolean; wide?: boolean; listSel?: string; storageGetterThrows?: boolean; crumbThrows?: boolean }
function page(opts: Opts = {}) {
  const total = opts.total ?? 1000
  const store = new Map<string, string>(Object.entries(opts.stored ?? {}))
  const writes: Array<[string, string]> = [], reads: string[] = []
  const storage = opts.throwing
    ? { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceededError') } }
    : { getItem: (k: string) => { reads.push(k); return store.get(k) ?? null }, setItem: (k: string, v: string) => { writes.push([k, v]); store.set(k, v) } }
  let wide = opts.wide ?? true
  const docListeners = new Map<string, Array<(e: any) => void>>(), winListeners = new Map<string, Array<(e: any) => void>>()
  const buttons: any[] = []
  const window: any = { addEventListener: (t: string, fn: any) => { (winListeners.get(t) ?? winListeners.set(t, []).get(t)!).push(fn) } }
  if (opts.storageGetterThrows) Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError') } })
  else window.localStorage = storage
  let clock = 1000
  // The drag-end layout report (11/10): app.js's layoutCrumb as a recorder, the page's width, the rail and the pan.
  const crumbs: Array<{ what: string; data: Record<string, unknown> }> = []
  window.visualViewport = { pageTop: 85.4, offsetTop: 0, scale: 0.85, pageLeft: 197.5, offsetLeft: 197.5 }
  window.scrollX = 0
  const ctx: any = vm.createContext({
    JSON, Math, String, Object, window, Date: { now: () => clock },
    matchMedia: (q: string) => ({ matches: wide, media: q }),
    $: () => null,
    layoutCrumb: (what: string, data: Record<string, unknown>) => { if (opts.crumbThrows) throw new Error('x'); crumbs.push({ what, data }); return true },
    document: {
      documentElement: { clientWidth: 1119, scrollWidth: 1316 },
      querySelector: (sel: string) => (sel === '.rail' ? { getBoundingClientRect: () => ({ top: -212, left: -197, right: -123 }) } : null),
      querySelectorAll: (sel: string) => ({ forEach: (f: any) => buttons.filter(b => b.matches(sel)).forEach(f) }),
      addEventListener: (t: string, fn: any) => { (docListeners.get(t) ?? docListeners.set(t, []).get(t)!).push(fn) },
    },
  })
  vm.runInContext(KIT_SRC + ';this.splitKit = splitKit; this.mount = mountSplit; this.handleHtml = splitHandleHtml; this.fullButton = splitFullButton; this.SX = SX_SPLIT_OPTS;', ctx)
  function els(listSel = opts.listSel ?? '.split-list') {
    const classes = new Set<string>(), props = new Map<string, string>(), attrs = new Map<string, string>()
    const listeners = new Map<string, Array<(e: any) => void>>()
    const split: any = {
      isConnected: true,
      classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) }, add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
      getBoundingClientRect: () => ({ width: total }),
      // The list as the stylesheet sizes it: 300 px by default, else the share (any --*-list-share) clamped by the CSS.
      querySelector: (sel: string) => sel !== listSel ? null : listEl,
    }
    // The split's children in order: the sized column, the divider, the other column (reader).
    const listEl: any = { getBoundingClientRect: () => {
      const s = [...props.values()][0]
      return { width: s ? parseFloat(s) / 100 * total : 300, top: -180, left: -99, right: 301 }
    } }
    const readerEl: any = { getBoundingClientRect: () => ({ left: 319, right: 901 }), nextElementSibling: null }
    const handle: any = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      addEventListener: (t: string, fn: any) => { (listeners.get(t) ?? listeners.set(t, []).get(t)!).push(fn) },
      removeEventListener: (t: string, fn: any) => { const l = listeners.get(t); if (l) l.splice(l.indexOf(fn) >>> 0, 1) },
      setPointerCapture: () => {},
      nextElementSibling: readerEl,
    }
    listEl.nextElementSibling = handle
    split.firstElementChild = listEl
    const fire = (type: string, e: any = {}) => {
      const ev = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, shiftKey: false, type, prevented: false, preventDefault() { this.prevented = true }, ...e }
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev)
      return ev
    }
    const drag = (from: number, to: number) => { fire('pointerdown', { clientX: from }); fire('pointermove', { clientX: to }); fire('pointerup', { clientX: to }) }
    return { split, handle, classes, props, attrs, fire, drag, listEl, readerEl }
  }
  // A Full width button as the page would hold it after a pane drew fullButton(key).
  const addButton = (key: string) => {
    const b: any = { attrs: new Map<string, string>([['data-split-full', key]]), textContent: '', setAttribute(k: string, v: string) { this.attrs.set(k, v) },
      getAttribute(k: string) { return this.attrs.get(k) ?? null }, matches: (sel: string) => sel === '[data-split-full="' + key + '"]' }
    b.closest = (sel: string) => sel === '[data-split-full]' ? b : null
    buttons.push(b)
    return b
  }
  const click = (target: any) => { for (const fn of docListeners.get('click') ?? []) fn({ target }) }
  const resize = () => { for (const fn of winListeners.get('resize') ?? []) fn({}) }
  return { ctx, els, storage, store, writes, reads, addButton, click, resize, crumbs, setWide: (w: boolean) => { wide = w }, tick: (ms: number) => { clock += ms } }
}

describe('one kit: Sessions is the same kit with its own options', () => {
  it('sxSplitKit is splitKit with the Sessions key, classes and limits; there is no second copy of the drag code', () => {
    const sx = slice(APP, '  function sxSplitKit(', '\n  }') + '\n'
    expect(sx).toContain('return splitKit(split, handle, storage, SX_SPLIT_OPTS)')
    expect(APP.match(/setPointerCapture/g)?.length, 'one drag implementation in app.js').toBe(1)
    const p = page()
    expect(p.ctx.SX.key).toBe('cos_web_sessions_split')
    expect(p.ctx.SX.prefix).toBe('sx')
    expect(p.ctx.SX.fullSel).toBe('[data-sx="full"]')
    expect(p.ctx.SX.media).toBe('(min-width: 760px)')
    for (const src of [MEM, MSG, MTG, WRK]) expect(src, 'the panes use W.splitKit, never their own drag code').not.toMatch(/setPointerCapture|col-resize/)
  })
  it('W.splitKit is on the shared kit (mount, the divider markup, the Full width button)', () => {
    expect(APP).toContain('splitKit: { mount: mountSplit, handle: splitHandleHtml, fullButton: splitFullButton }')
  })
})

describe('each pane keeps its own width', () => {
  it('Sessions, Memories, Messages, Meetings and Work store under five different keys', () => {
    const keys = [/SX_SPLIT_KEY = '([^']+)'/.exec(APP)![1], MEM_OPTS.key, MSG_OPTS.key, MTG_OPTS.key, WRK_OPTS.key]
    expect(keys).toEqual(['cos_web_sessions_split', 'cos_web_memories_split', 'cos_web_messages_split', 'cos_web_meetings_split', 'cos_web_work_split'])
    expect(new Set(keys).size).toBe(5)
  })
  it('a kit reads and writes only its own key: a Memories drag never moves Messages, and each reads back its own width', () => {
    const p = page({ stored: { cos_web_messages_split: JSON.stringify({ share: 33, full: false }) } })
    const a = p.els(), b = p.els('.msg-left')
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    p.ctx.mount(b.split, b.handle, MSG_OPTS)
    expect(a.classes.has('split-sized'), 'Memories does not take the Messages width').toBe(false)
    expect(b.props.get('--split-list-share')).toBe('33.00%')
    a.drag(400, 500)
    expect(p.writes.map(w => w[0])).toEqual(['cos_web_memories_split'])
    expect(JSON.parse(p.store.get('cos_web_memories_split')!)).toEqual({ share: 40, full: false })
    expect(JSON.parse(p.store.get('cos_web_messages_split')!), 'untouched').toEqual({ share: 33, full: false })
    expect(b.props.get('--split-list-share')).toBe('33.00%')
    expect([...new Set(p.reads)].sort()).toEqual(['cos_web_memories_split', 'cos_web_messages_split'])
  })
})

describe('storage that throws, or is not there', () => {
  it('get and set both throwing: the divider still drags, resets and goes full width; the choice lasts the visit', () => {
    const p = page({ throwing: true })
    const a = p.els()
    const kit = p.ctx.splitKit(a.split, a.handle, p.storage, MEM_OPTS)
    a.drag(400, 500)
    expect(a.props.get('--split-list-share')).toBe('40.00%')
    kit.toggleFull()
    expect(a.classes.has('split-full')).toBe(true)
    a.fire('dblclick')
    expect(a.classes.has('split-sized')).toBe(false)
  })
  it('window.localStorage itself throwing (a private window): mount still binds, and a pane that redraws keeps this visit’s width', () => {
    const p = page({ storageGetterThrows: true })
    const a = p.els()
    expect(p.ctx.mount(a.split, a.handle, MEM_OPTS)).not.toBeNull()
    a.drag(400, 520)
    expect(a.props.get('--split-list-share')).toBe('42.00%')
    const again = p.els()
    p.ctx.mount(again.split, again.handle, MEM_OPTS)
    expect(again.props.get('--split-list-share'), 'redrawn split, same width').toBe('42.00%')
  })
  it('storage off: this visit’s width is kept per pane, so a Memories drag never sizes Messages when it is drawn', () => {
    const p = page({ storageGetterThrows: true })
    const a = p.els()
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    a.drag(400, 520)
    const m = p.els('.msg-left')
    p.ctx.mount(m.split, m.handle, MSG_OPTS)
    expect(m.classes.has('split-sized')).toBe(false)
    expect(m.props.size).toBe(0)
  })
  it('junk in storage is ignored', () => {
    for (const v of ['{not json', JSON.stringify({ share: 140 }), JSON.stringify({ share: '40' }), 'null']) {
      const p = page({ stored: { cos_web_memories_split: v } })
      const a = p.els()
      p.ctx.mount(a.split, a.handle, MEM_OPTS)
      expect(a.classes.has('split-sized'), v).toBe(false)
    }
  })
})

describe('below a pane’s breakpoint the divider does nothing', () => {
  it('narrow: a drag, a key, a double tap and a double click change nothing and write nothing; nothing is prevented', () => {
    const p = page({ wide: false })
    const a = p.els()
    p.ctx.mount(a.split, a.handle, MSG_OPTS)
    expect(a.fire('pointerdown', { clientX: 400 }).prevented, 'the touch stays the page’s').toBe(false)
    a.fire('pointermove', { clientX: 600 }); a.fire('pointerup', { clientX: 600 })
    expect(a.classes.has('split-dragging')).toBe(false)
    expect(a.fire('keydown', { key: 'ArrowRight' }).prevented).toBe(false)
    expect(a.fire('dblclick').prevented).toBe(false)
    expect(a.classes.has('split-sized')).toBe(false)
    expect(p.writes).toEqual([])
  })
  it('folding mid-drag (wide, then narrow before the move): the move changes nothing; nor does a direct setWidth', () => {
    const p = page()
    const a = p.els()
    const kit = p.ctx.mount(a.split, a.handle, MEM_OPTS)
    a.fire('pointerdown', { clientX: 400 })
    p.setWide(false)
    a.fire('pointermove', { clientX: 520 }); a.fire('pointerup', { clientX: 520 })
    expect(a.classes.has('split-sized')).toBe(false)
    kit.setWidth(500, true)
    expect(a.props.has('--split-list-share')).toBe(false)
  })
  it('a stored width is kept for when the screen is wide again, and a narrow screen does not reset it', () => {
    const p = page({ wide: false, stored: { cos_web_memories_split: JSON.stringify({ share: 45, full: false }) } })
    const a = p.els()
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    a.fire('dblclick')
    expect(a.props.get('--split-list-share')).toBe('45.00%')
    p.setWide(true)
    a.fire('keydown', { key: 'ArrowRight' })
    expect(a.props.get('--split-list-share')).toBe('46.60%')
  })
  it('each pane names its own breakpoint, the one its CSS uses for two columns', () => {
    expect(MEM_OPTS.media).toBe('(min-width: 760px)')
    expect(MSG_OPTS.media).toBe('(min-width: 860px)')
    expect(MTG_OPTS.media).toBe('(min-width: 860px)')
    expect(WRK_OPTS.media).toBe('(min-width: 900px)')
  })
})

describe('limits, reset and keys, with each pane’s numbers', () => {
  it('Memories: the list keeps 240 px, the reader 380 px past the 18 px divider', () => {
    const p = page(), a = p.els()
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    a.drag(400, -5000); expect(a.props.get('--split-list-share')).toBe('24.00%')
    a.drag(400, 5000); expect(a.props.get('--split-list-share')).toBe('60.20%')
    expect([a.attrs.get('aria-valuemin'), a.attrs.get('aria-valuemax')]).toEqual(['24', '60'])
    expect(a.attrs.get('aria-valuetext')).toBe('Memories list 60% of the width')
  })
  it('Messages: the list keeps 240 px, the chat 440 px (room for its composer) past the 24 px divider (1000 px, the unfolded Duo turned)', () => {
    const p = page(), a = p.els('.msg-left')
    p.ctx.mount(a.split, a.handle, MSG_OPTS)
    a.drag(400, -5000); expect(a.props.get('--split-list-share')).toBe('24.00%')
    a.drag(400, 5000); expect(a.props.get('--split-list-share')).toBe('53.60%')
    expect(a.attrs.get('aria-valuetext')).toBe('Message list 54% of the width')
  })
  it('a double tap or a double click goes back to the default width and saves that; taps far apart do not', () => {
    const p = page(), a = p.els()
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    a.drag(400, 520)
    a.drag(400, 400); p.tick(400); a.drag(400, 400)
    expect(a.classes.has('split-sized'), 'taps 400 ms apart are two single taps').toBe(true)
    p.tick(100); a.drag(400, 400)
    expect(a.classes.has('split-sized')).toBe(false)
    expect(JSON.parse(p.store.get('cos_web_memories_split')!)).toEqual({ share: null, full: false })
    a.drag(400, 520)
    expect(a.fire('dblclick').prevented).toBe(true)
    expect(a.classes.has('split-sized')).toBe(false)
    expect(a.props.has('--split-list-share')).toBe(false)
  })
  it('keyboard: arrows step 16 px, Shift 64, Home and End go to the limits; each press is kept; other keys pass', () => {
    const p = page(), a = p.els()
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    expect(a.fire('keydown', { key: 'ArrowRight' }).prevented).toBe(true)
    expect(a.props.get('--split-list-share')).toBe('31.60%')
    a.fire('keydown', { key: 'ArrowLeft', shiftKey: true }); expect(a.props.get('--split-list-share')).toBe('25.20%')
    a.fire('keydown', { key: 'End' }); expect(a.props.get('--split-list-share')).toBe('60.20%')
    a.fire('keydown', { key: 'Home' }); expect(a.props.get('--split-list-share')).toBe('24.00%')
    expect(p.writes.length).toBe(4)
    expect(a.fire('keydown', { key: 'Tab' }).prevented).toBe(false)
  })
})

describe('Full width and the page wiring', () => {
  it('a Full width button toggles its own pane only, says which, and is drawn with the state in force', () => {
    const p = page(), a = p.els(), b = p.els('.msg-left')
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    p.ctx.mount(b.split, b.handle, MSG_OPTS)
    const btn = p.addButton(MEM_OPTS.key)
    expect(p.ctx.fullButton(MEM_OPTS.key, 'mm-list-col')).toContain('>Full width</button>')
    p.click(btn)
    expect(a.classes.has('split-full')).toBe(true)
    expect(b.classes.has('split-full')).toBe(false)
    expect(btn.textContent).toBe('Show list')
    expect(btn.attrs.get('aria-pressed')).toBe('true')
    const html = p.ctx.fullButton(MEM_OPTS.key, 'mm-list-col')
    expect(html).toBe('<button type="button" class="cx-btn quiet split-full-btn" data-split-full="cos_web_memories_split" aria-controls="mm-list-col" aria-pressed="true">Show list</button>')
    p.click(btn)
    expect(a.classes.has('split-full')).toBe(false)
  })
  it('a turned screen repaints every divider on the page', () => {
    const p = page(), a = p.els()
    p.ctx.mount(a.split, a.handle, MEM_OPTS)
    a.attrs.delete('aria-valuenow')
    p.resize()
    expect(a.attrs.get('aria-valuenow')).toBe('30')
  })
  it('mount binds once per drawn split: painting the same elements again adds no second set of listeners', () => {
    const p = page(), a = p.els()
    const k1 = p.ctx.mount(a.split, a.handle, MEM_OPTS), k2 = p.ctx.mount(a.split, a.handle, MEM_OPTS)
    expect(k2).toBe(k1)
    a.fire('keydown', { key: 'ArrowRight' })
    expect(p.writes.length, 'one key press, one write').toBe(1)
  })
  it('the divider markup: a focusable vertical separator naming the list it sizes', () => {
    const p = page()
    const html = p.ctx.handleHtml({ id: 'mm-handle', controls: 'mm-list-col', label: 'Memories list' })
    for (const a of ['class="split-handle"', 'role="separator"', 'aria-orientation="vertical"', 'tabindex="0"', 'aria-controls="mm-list-col"',
      'aria-label="Memories list width"', 'id="mm-handle"', 'title="Drag to resize. Double-tap or double-click to reset."']) expect(html).toContain(a)
  })
})

describe('the panes', () => {
  it('Memories: the divider sits between the list and the reader, is mounted on paint, and its readers carry Full width', () => {
    const sk = slice(MEM, '  var SKELETON = ', '\n  function write(')
    const list = sk.indexOf('id="mm-list-col"'), handle = sk.indexOf('SPLIT_HANDLE'), reader = sk.indexOf('id="mm-reader"')
    expect(list).toBeGreaterThan(-1); expect(handle).toBeGreaterThan(list); expect(reader).toBeGreaterThan(handle)
    expect(MEM).toContain("SPLIT_KIT.mount(split, el('mm-handle'), SPLIT);")
    expect(MEM_OPTS).toMatchObject({ controls: 'mm-list-col', listMin: 240, readerMin: 380, handleW: 18 })
    // readerHead from the real file: the button joins the head's actions.
    const ctx: any = vm.createContext({ esc: (s: string) => s, SPLIT: MEM_OPTS, SPLIT_KIT: { fullButton: (k: string, c: string) => '<FULL ' + k + ' ' + c + '>' } })
    vm.runInContext(slice(MEM, '  function readerHead(', '  function eventReader(') + ';this.readerHead = readerHead;', ctx)
    expect(ctx.readerHead('T', '', '')).toBe('<div class="mm-reader-head"><h2 class="mm-title">T</h2><div class="mm-actions"><FULL cos_web_memories_split mm-list-col></div></div>')
    expect(ctx.readerHead('T', 'f', '<b>x</b>')).toContain('<div class="mm-actions"><b>x</b><FULL cos_web_memories_split mm-list-col></div>')
    expect(MEM, 'the list hides only while a reader with the button is open').toContain("split.classList.toggle('mm-fullable', !!(node.querySelector && node.querySelector('[data-split-full]')))")
  })
  it('Messages: the divider sits between the list and the chat and is mounted with the split; no Full width (the chat’s header is cos-chat.js’s)', () => {
    const host = slice(MSG, '  function splitHost() {', '  function renderList() {')
    const left = host.indexOf('id="msg-left"'), handle = host.indexOf("SPLIT_KIT.handle({ id: 'msg-handle'"), right = host.indexOf('id="msg-right"')
    expect(left).toBeGreaterThan(-1); expect(handle).toBeGreaterThan(left); expect(right).toBeGreaterThan(handle)
    expect(host).toContain("SPLIT_KIT.mount(split, $('msg-handle'), SPLIT);")
    expect(MSG_OPTS).toMatchObject({ controls: 'msg-left', sized: '.msg-left', listMin: 240, readerMin: 440, handleW: 24 })
  })
  it('a page without the kit (a stand-in W) still draws both panes, with no divider', () => {
    for (const src of [MEM, MSG, MTG, WRK]) expect(src).toMatch(/var SPLIT_KIT = W\.splitKit \|\| \{ handle: function \(\) \{ return ''; \}/)
  })
})

describe('the stylesheet', () => {
  const APPCSS = noComments(read('app.css')), MEMCSS = noComments(read('panes/memories.css')), CHAT = noComments(read('panes/cos-chat.css'))
  // The body of the first "@media (min-width: Npx) {" block that contains `needle`.
  const mediaWith = (css: string, px: number, needle: string) => {
    let at = 0
    for (;;) {
      const i = css.indexOf('@media (min-width: ' + px + 'px) {', at)
      expect(i, px + ' px block with ' + needle).toBeGreaterThan(-1)
      let depth = 0, j = css.indexOf('{', i)
      for (let k = j; k < css.length; k++) { if (css[k] === '{') depth++; else if (css[k] === '}' && --depth === 0) { j = k; break } }
      const body = css.slice(i, j + 1)
      if (body.includes(needle)) return body
      at = j
    }
  }
  const outsideMedia = (css: string) => css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  it('the divider and Full width are hidden everywhere by default (a phone never sees them)', () => {
    expect(outsideMedia(APPCSS)).toMatch(/^\.split-handle, \.split-full-btn \{ display: none; \}/m)
    expect(outsideMedia(MEMCSS), 'Memories shows it only inside its breakpoint').not.toMatch(/\.split-handle \{ display: flex/)
    expect(outsideMedia(CHAT), 'Messages shows it only inside its breakpoint').not.toMatch(/\.split-handle \{ display: flex/)
    const h = APPCSS.slice(APPCSS.indexOf('.split-handle {'), APPCSS.indexOf('}', APPCSS.indexOf('.split-handle {')))
    expect(h).toMatch(/touch-action:\s*none/)
    expect(h, 'display comes only from a pane’s breakpoint').not.toMatch(/display:/)
  })
  it('Memories from 760 px: the default columns unchanged, the clamp matches memories.js SPLIT, solo views hide it', () => {
    const wide = mediaWith(MEMCSS, 760, '.split.mm-split > .split-handle')
    expect(wide).toMatch(/\.split\.mm-split > \.split-handle \{ display: flex; \}/)
    expect(wide).toMatch(/\.split\.mm-split \{ grid-template-columns: minmax\(260px, 340px\) 18px minmax\(0, 1fr\); column-gap: 0; \}/)
    const lim = /\.split\.mm-split\.split-sized \{ grid-template-columns: clamp\((\d+)px, var\(--split-list-share, 30%\), calc\(100% - (\d+)px\)\) (\d+)px/.exec(wide)
    expect(lim).not.toBeNull()
    expect(Number(lim![1])).toBe(MEM_OPTS.listMin)
    expect(Number(lim![2])).toBe(MEM_OPTS.readerMin + MEM_OPTS.handleW)
    expect(Number(lim![3])).toBe(MEM_OPTS.handleW)
    expect(wide).toMatch(/\.split\.mm-split\.split-full\.mm-fullable:not\(\.solo\) \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(wide).toMatch(/\.split\.mm-split\.split-full\.mm-fullable:not\(\.solo\) > \.split-list, \.split\.mm-split\.split-full\.mm-fullable:not\(\.solo\) > \.split-handle \{ display: none; \}/)
    expect(wide).toMatch(/\.mm-reader \.split-full-btn \{ display: inline-flex; \}/)
    expect(MEMCSS).toMatch(/\.split\.mm-split\.solo > \.split-handle \{ display: none; \}/)
  })
  it('Messages from 860 px: the 24 px gap is the divider’s column, the clamp matches messages.js SPLIT', () => {
    const wide = mediaWith(CHAT, 860, '.msg-split > .split-handle')
    expect(wide).toMatch(/\.msg-split \{ display: grid; grid-template-columns: minmax\(300px, 40%\) 24px minmax\(0, 1fr\); column-gap: 0;/)
    expect(wide).toMatch(/\.msg-split > \.split-handle \{ display: flex;/)
    const lim = /\.msg-split\.split-sized \{ grid-template-columns: clamp\((\d+)px, var\(--split-list-share, 40%\), calc\(100% - (\d+)px\)\) (\d+)px/.exec(wide)
    expect(lim).not.toBeNull()
    expect(Number(lim![1])).toBe(MSG_OPTS.listMin)
    expect(Number(lim![2])).toBe(MSG_OPTS.readerMin + MSG_OPTS.handleW)
    expect(Number(lim![3])).toBe(MSG_OPTS.handleW)
  })
  it('a finger gets at least 44 px on every pane; dragging stops the panes taking the pointer', () => {
    const coarse = /@media \(pointer: coarse\) \{ \.split-handle::before \{[^}]*left: -(\d+)px; right: -(\d+)px; \} \}/.exec(APPCSS)
    expect(coarse).not.toBeNull()
    for (const o of [MEM_OPTS, MSG_OPTS, MTG_OPTS, WRK_OPTS]) expect(o.handleW + Number(coarse![1]) + Number(coarse![2])).toBeGreaterThanOrEqual(44)
    expect(APPCSS).toMatch(/\.split-dragging > :not\(\.split-handle\) \{ pointer-events: none; \}/)
    expect(APPCSS).toMatch(/@media \(pointer: coarse\) \{ \.split-full-btn \{ min-height: 44px; \} \}/)
  })
})

// A side panel on the right (Meetings Ask, Work): the same kit, mirrored. 1000 px wide; the panel starts at 300 px.
describe('a side panel on the right: the line moves the same way, the panel on the other side of it', () => {
  it('Meetings: dragging the line left widens the Ask panel; limits are the panel’s 280 px and the notes’ 380 px', () => {
    const p = page(), a = p.els('.mt-side-panel')
    p.ctx.mount(a.split, a.handle, MTG_OPTS)
    a.drag(500, 400)
    expect(a.props.get('--split-side-share'), 'line 100 px left: panel 400 px').toBe('40.00%')
    expect(a.props.has('--split-list-share')).toBe(false)
    a.drag(500, 5000); expect(a.props.get('--split-side-share')).toBe('28.00%')
    a.drag(500, -5000); expect(a.props.get('--split-side-share')).toBe('59.60%')
    expect(a.attrs.get('aria-valuetext')).toBe('Ask panel 60% of the width')
    const saved = JSON.parse(p.store.get('cos_web_meetings_split')!)
    expect(saved.share).toBeCloseTo(59.6, 6)
    expect(saved.full).toBe(false)
  })
  it('Work: arrows move the line the way they point (Left widens the panel), Home and End take it to the left and right limits', () => {
    const p = page(), a = p.els('.wk-detail-side')
    p.ctx.mount(a.split, a.handle, WRK_OPTS)
    a.fire('keydown', { key: 'ArrowLeft' }); expect(a.props.get('--split-side-share'), '316 px is under the 320 px floor').toBe('32.00%')
    a.fire('keydown', { key: 'ArrowLeft' }); expect(a.props.get('--split-side-share')).toBe('33.60%')
    a.fire('keydown', { key: 'ArrowLeft', shiftKey: true }); expect(a.props.get('--split-side-share')).toBe('40.00%')
    a.fire('keydown', { key: 'ArrowRight' }); expect(a.props.get('--split-side-share')).toBe('38.40%')
    a.fire('keydown', { key: 'Home' }); expect(a.props.get('--split-side-share'), 'line far left: card 380 px past 22').toBe('59.80%')
    a.fire('keydown', { key: 'End' }); expect(a.props.get('--split-side-share'), 'line far right: panel 320 px').toBe('32.00%')
    a.fire('dblclick'); expect(a.classes.has('split-sized')).toBe(false)
  })
  it('Meetings: the divider sits between the notes and the Ask panel, saved and live, and is mounted with each', () => {
    const det = slice(MTG, '  function paintDetail() {', '  // Duo tables: the divider between a meeting')
    expect(det).toContain("var divider = sessions.length ? SPLIT_KIT.handle({ id: 'mt-dhandle', controls: 'mt-ask-' + safeId(sessions[0]), label: SPLIT.label }) : '';")
    expect(det).toContain("'<div class=\"mt-dbody' + (divider ? ' split-side' : '') + '\" id=\"mt-dbody\">' + divider +")
    expect(det).toContain("SPLIT_KIT.mount($('mt-dbody'), $('mt-dhandle'), SPLIT);")
    const live = slice(MTG, "    var divider = SPLIT_KIT.handle({ id: 'mt-lhandle'", '    S.headHtml = S.footHtml')
    const main = live.indexOf('id="mt-lmain"'), handle = live.indexOf("+ divider +"), aside = live.indexOf('<aside class="mt-side-panel"')
    expect(main).toBeGreaterThan(-1); expect(handle).toBeGreaterThan(main); expect(aside).toBeGreaterThan(handle)
    expect(live).toContain("SPLIT_KIT.mount($('mt-lgrid'), $('mt-lhandle'), SPLIT);")
    expect(MTG_OPTS).toMatchObject({ side: 'end', sized: '.mt-side-panel', cssVar: '--split-side-share', listMin: 280, readerMin: 380, handleW: 24 })
  })
  it('Work: the divider sits between the card and its side panel and is mounted on every paint (a repaint in place reuses it)', () => {
    const det = slice(WRK, '  function renderDetail(arg) {', '  // ── Work chat:')
    const main = det.indexOf('<div class="wk-detail-main">'), handle = det.indexOf('SPLIT_HANDLE + '), side = det.indexOf('<aside class="wk-detail-side"')
    expect(main).toBeGreaterThan(-1); expect(handle).toBeGreaterThan(main); expect(side).toBeGreaterThan(handle)
    expect(det).toContain("SPLIT_KIT.mount(pane.querySelector('.wk-detail'), $('wk-handle'), DIVIDER);")
    expect(WRK_OPTS).toMatchObject({ side: 'end', sized: '.wk-detail-side', cssVar: '--split-side-share', listMin: 320, readerMin: 380, handleW: 22 })
    expect(WRK, 'the Sort split keeps its own name').toMatch(/var SPLIT = null, SPLIT_KEY = '';/)
  })
  it('the stylesheets: shown only from each pane’s breakpoint, the default columns unchanged, clamps match the options', () => {
    const MT = noComments(read('panes/meetings.css')), WK = noComments(read('panes/work.css'))
    const check = (css: string, px: number, sel: string, o: any) => {
      const at = css.lastIndexOf('@media (min-width: ' + px + 'px) {')
      const body = css.slice(at)
      expect(body).toContain(sel + '.split-sized { grid-template-columns: minmax(0, 1fr) ' + o.handleW + 'px clamp(' + o.listMin + 'px, var(' + o.cssVar + ', 30%), calc(100% - ' + (o.readerMin + o.handleW) + 'px)); }')
      expect(body).toMatch(new RegExp(sel.replace(/\./g, '\\.') + ' > \\.split-handle \\{ display: flex;'))
      expect(css.slice(0, at), 'not shown before the breakpoint').not.toContain(sel + ' > .split-handle')
    }
    check(MT, 860, '.mt-detail .mt-dbody.split-side', MTG_OPTS)
    check(MT, 860, '.mt-lgrid.split-side', MTG_OPTS)
    expect(MT).toContain('.mt-detail .mt-dbody.split-side { grid-template-columns: minmax(0, 1fr) 24px minmax(280px, min(380px, 38%)); column-gap: 0; }')
    expect(MT).toContain('.mt-detail .mt-dbody.split-side > :not(.mt-doc):not(.split-handle) { grid-column: 3; }')
    const wk = WK.slice(WK.indexOf('@media (min-width: 900px) {\n  .wk-detail.split-side'))
    expect(wk).toContain('.wk-detail.split-side { grid-template-columns: minmax(0, 1fr) 22px minmax(320px, 400px); column-gap: 0; }')
    expect(wk).toContain('.wk-detail.split-side.split-sized { grid-template-columns: minmax(0, 1fr) 22px clamp(320px, var(--split-side-share, 30%), calc(100% - 402px)); }')
    expect(wk).toContain('.wk-detail.split-side > .split-handle { display: flex; }')
    expect(WK).toContain('@media (min-width: 1300px) { .wk-detail.split-side { grid-template-columns: minmax(0, 1fr) 22px 452px; } }')
  })
})

// 11/10 (lead 20:39): Miles squeezes the reader on his Duo's Home Screen web app and the page breaks; WebKit at scale 1
// does not. One report when a drag ends says what his page did. Diagnostic only: the drag itself is unchanged.
describe('the drag-end layout report', () => {
  it('a drag sends one split-drag report: the widths, the share, the page width and scroll width, the pan, the rail and list tops', () => {
    const p = page()
    const a = p.els()
    p.ctx.splitKit(a.split, a.handle, p.storage, MEM_OPTS)
    a.drag(400, 500)
    expect(p.crumbs).toEqual([{ what: 'split-drag', data: { key: 'cos_web_memories_split', t: 1000, sz: 400, rw: 582, share: 40,
      cw: 1119, scw: 1316, pt: 85.4, pl: 197.5, ol: 197.5, sx: 0,
      railTop: -212, railL: -197, railR: -123, listTop: -180, listL: -99, listR: 301, rdL: 319, rdR: 901 } }])
  })
  it('sideways: the page scrolled sideways reads in sx; no visualViewport or rail reads -1, never a missing key', () => {
    const p = page()
    const a = p.els()
    p.ctx.window.scrollX = 214
    delete p.ctx.window.visualViewport
    p.ctx.document.querySelector = () => null
    p.ctx.splitKit(a.split, a.handle, p.storage, MEM_OPTS)
    a.drag(400, 500)
    expect(p.crumbs[0]!.data).toMatchObject({ sx: 214, pt: -1, pl: -1, ol: -1, railTop: -1, railL: -1, railR: -1, listL: -99, rdL: 319, rdR: 901 })
  })
  it('a side panel on the right (the sized column last, as on a Work card): the other column is still the reader', () => {
    const p = page()
    const a = p.els()
    // Order: reader, divider, sized column.
    a.split.firstElementChild = a.readerEl; a.readerEl.nextElementSibling = a.handle; a.handle.nextElementSibling = a.listEl; a.listEl.nextElementSibling = null
    p.ctx.splitKit(a.split, a.handle, p.storage, WRK_OPTS.sized ? { ...WRK_OPTS, sized: '.split-list' } : WRK_OPTS)
    a.drag(500, 400)
    expect(p.crumbs[0]!.data).toMatchObject({ rdL: 319, rdR: 901, listL: -99, listR: 301 })
  })
  it('a tap, a double tap, the arrow keys and a cancelled press send nothing', () => {
    const p = page()
    const a = p.els()
    p.ctx.splitKit(a.split, a.handle, p.storage, MEM_OPTS)
    a.fire('pointerdown', { clientX: 400 }); a.fire('pointerup', { clientX: 400 })
    a.fire('pointerdown', { clientX: 400 }); a.fire('pointerup', { clientX: 400 })
    a.fire('keydown', { key: 'ArrowRight' }); a.fire('keydown', { key: 'End' })
    a.fire('pointerdown', { clientX: 400 }); a.fire('pointercancel', { clientX: 400 })
    expect(p.crumbs).toEqual([])
  })
  it('at most six a page load, across every divider on the page', () => {
    const p = page()
    const a = p.els(), b = p.els('.msg-left')
    p.ctx.splitKit(a.split, a.handle, p.storage, MEM_OPTS)
    p.ctx.splitKit(b.split, b.handle, p.storage, MSG_OPTS)
    for (let i = 0; i < 5; i++) { a.drag(400, 420 + i * 10); b.drag(400, 420 + i * 10) }
    expect(p.crumbs).toHaveLength(6)
    expect(new Set(p.crumbs.map(c => c.data.key))).toEqual(new Set(['cos_web_memories_split', 'cos_web_messages_split']))
  })
  it('a failing report never stops the drag or its saved width', () => {
    const p = page({ crumbThrows: true })
    const a = p.els()
    p.ctx.splitKit(a.split, a.handle, p.storage, MEM_OPTS)
    a.drag(400, 500)
    expect(a.props.get('--split-list-share')).toBe('40.00%')
    expect(JSON.parse(p.store.get('cos_web_memories_split')!)).toEqual({ share: 40, full: false })
  })
  it('fits layoutCrumb: short keys, numbers, and a key name of 24 characters or fewer', () => {
    const p = page()
    const a = p.els()
    p.ctx.splitKit(a.split, a.handle, p.storage, MSG_OPTS)
    a.drag(400, 500)
    for (const [k, v] of Object.entries(p.crumbs[0]!.data)) {
      expect(k).toMatch(/^[a-z][a-zA-Z0-9]{0,15}$/)
      expect(typeof v === 'number' || (typeof v === 'string' && v.length <= 24), k).toBe(true)
    }
    for (const o of [MEM_OPTS, MSG_OPTS, MTG_OPTS, WRK_OPTS, p.ctx.SX]) expect(String(o.key).length, o.key).toBeLessThanOrEqual(24)
  })
})
