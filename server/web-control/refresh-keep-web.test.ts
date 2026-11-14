/**
 * F1 (lead 15:55, triage A4 first step): a refresh keeps what is on screen. Threads, Settings and Dictation used to
 * blank their data on Refresh (S.rows / S.data / S.glossary = null), so the page dropped to a skeleton under the
 * reader and a value being typed was lost. Now each keeps its rows while the new ones load, swaps them in place, keeps
 * a field that has focus or an unsaved value, and on a failed refresh keeps the old rows with one line:
 * "Could not refresh. Showing what was there at <time>." and Try again.
 * Runs the real pane files in a vm with a fake COSWeb and a fake pane whose innerHTML turns its form fields into
 * elements (value, defaultValue, focus), so a re-render really replaces them.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = (f: string) => readFileSync(join(HERE, 'panes', f), 'utf8')
const SKEL = '<i class="skeleton-marker"></i>'
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

type El = { tagName: string; id: string; attrs: Record<string, string>; value: string; defaultValue: string; type: string;
  selectionStart: number; selectionEnd: number; getAttribute: (k: string) => string | null; focus: (o?: unknown) => void;
  setSelectionRange: (a: number, b: number) => void; closest: () => null }

function fakeDoc() { return { activeElement: null as El | null, getElementById: () => null } }

/** A pane whose innerHTML setter builds an element for every input and textarea in the markup. */
function fakePane(doc: ReturnType<typeof fakeDoc>) {
  let html = ''
  let els: El[] = []
  const listeners: Record<string, (e: unknown) => void> = {}
  const make = (tag: string, attrStr: string, inner: string | null): El => {
    const attrs: Record<string, string> = {}
    attrStr.replace(/([a-zA-Z0-9-]+)="([^"]*)"/g, (_m, k, v) => { attrs[k] = unesc(v); return '' })
    const value = tag === 'textarea' ? unesc(inner || '') : (attrs.value ?? '')
    const el: El = {
      tagName: tag.toUpperCase(), id: attrs.id || '', attrs, value, defaultValue: value, type: attrs.type || 'text',
      selectionStart: value.length, selectionEnd: value.length,
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      focus: () => { doc.activeElement = el },
      setSelectionRange: (a: number, b: number) => { el.selectionStart = a; el.selectionEnd = b },
      closest: () => null,
    }
    return el
  }
  const pane = {
    get innerHTML() { return html },
    set innerHTML(h: string) {
      html = h
      if (doc.activeElement && els.includes(doc.activeElement)) doc.activeElement = null  // a replaced node loses focus
      els = []
      h.replace(/<input\b([^>]*)>/g, (_m, a) => { els.push(make('input', a, null)); return '' })
      h.replace(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g, (_m, a, inner) => { els.push(make('textarea', a, inner)); return '' })
    },
    els: () => els,
    querySelectorAll: (_sel: string) => els,
    querySelector: (sel: string) => {
      const id = /^#([\w-]+)$/.exec(sel); if (id) return els.find(e => e.id === id[1]) || null
      const at = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel); if (at) return els.find(e => e.attrs[at[1]] === at[2]) || null
      return null
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn },
    classList: { contains: () => false, toggle: () => {}, add: () => {}, remove: () => {} },
    listeners,
  }
  return pane
}

/** api answers: a value, or a function. hold() makes the next reads wait until release(ok). */
function harness(file: string, paneId: string, route: { pane: string; args: string[] }, answers: Record<string, unknown>) {
  const doc = fakeDoc()
  const pane = fakePane(doc)
  let holding = false
  const held: Array<{ path: string; res: (v: unknown) => void; rej: (e: unknown) => void }> = []
  let loadFn: ((args?: string[]) => void) | null = null
  const W = {
    $: (id: string) => id === paneId ? pane : pane.querySelector('#' + id), esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    md: (s: unknown) => String(s), state: { serverName: 'Test-Mac' }, skeletonRows: () => SKEL, toast: () => {}, copyText: () => Promise.resolve(),
    parseRoute: () => route, go: () => {}, setCrumb: () => {}, armTap: () => true, petPrefs: () => ({}), setPetPrefs: () => {}, resetTodayBrief: () => {},
    clock: (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    registerPane: (_n: string, def: { load: (args?: string[]) => void }) => { loadFn = def.load },
    api: (path: string) => {
      const key = path.split('?')[0]
      if (holding) return new Promise((res, rej) => held.push({ path: key, res, rej }))
      if (!(key in answers)) return Promise.reject(Object.assign(new Error('404'), { status: 404 }))
      const a = answers[key]
      try { return Promise.resolve(typeof a === 'function' ? (a as () => unknown)() : a) } catch (e) { return Promise.reject(e) }
    },
  }
  const ctx = vm.createContext({ window: { COSWeb: W }, document: doc, console, Promise, Number, String, isFinite, Date, Array, Object, JSON, Math, setTimeout, clearTimeout })
  vm.runInContext(src(file), ctx)
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)) }
  const click = (attr: string, act: string) => pane.listeners.click({
    target: { closest: (sel: string) => sel === `[${attr}]` ? { getAttribute: (k: string) => k === attr ? act : null } : null },
  })
  return {
    pane, doc, flush, click,
    open: async () => { loadFn!(route.args); await flush() },
    hold: () => { holding = true },
    release: async (ok: boolean) => {
      holding = false
      for (const h of held.splice(0)) {
        if (!ok) h.rej(Object.assign(new Error('Server unreachable'), { status: 0 }))
        else if (h.path in answers) { const a = answers[h.path]; h.res(typeof a === 'function' ? (a as () => unknown)() : a) }
        else h.rej(Object.assign(new Error('404'), { status: 404 }))
      }
      await flush()
    },
    /** Type into a field: it gets focus and a value that differs from what the server sent. */
    type: (sel: string, value: string) => { const el = pane.querySelector(sel) as El; expect(el, sel).toBeTruthy(); el.value = value; el.focus(); el.setSelectionRange(2, 2); return el },
  }
}

const FAIL = /Could not refresh\. Showing what was there at \d{1,2}:\d{2}\s?[AP]M\./

describe('Threads: Refresh keeps the list', () => {
  const answers = { '/api/threads': { threads: [{ id: 't1', name: 'Pricing page rebuild' }, { id: 't2', name: 'Webinar dates' }] }, '/api/context/status': { threads: { active: 2 } } }
  it('while a refresh loads, the rows stay on screen (no "Loading threads…")', async () => {
    const h = harness('threads.js', 'pane-threads', { pane: 'threads', args: [] }, answers)
    await h.open()
    expect(h.pane.innerHTML).toContain('Pricing page rebuild')
    h.hold(); h.click('data-th', 'refresh'); await h.flush()
    expect(h.pane.innerHTML).toContain('Pricing page rebuild')
    expect(h.pane.innerHTML).not.toContain('Loading threads')
    await h.release(true)
    expect(h.pane.innerHTML).toContain('Webinar dates')
    expect(h.pane.innerHTML).not.toMatch(FAIL)
  })
  it('a failed refresh keeps the rows and says so in one line, with Try again', async () => {
    const h = harness('threads.js', 'pane-threads', { pane: 'threads', args: [] }, answers)
    await h.open()
    h.hold(); h.click('data-th', 'refresh'); await h.flush(); await h.release(false)
    expect(h.pane.innerHTML).toContain('Pricing page rebuild')
    expect(h.pane.innerHTML).toMatch(FAIL)
    expect(h.pane.innerHTML).toMatch(/data-th="refresh"[^>]*>Try again</)
  })
  it('a failed first load (nothing on screen yet) still shows the error, not the refresh line', async () => {
    const h = harness('threads.js', 'pane-threads', { pane: 'threads', args: [] }, {})
    await h.open()
    expect(h.pane.innerHTML).not.toMatch(FAIL)
    expect(h.pane.innerHTML).toContain('cx-notice warn')
  })
})

describe('Dictation: Refresh keeps the dictionary and what is being typed', () => {
  const answers = { '/api/transcription-glossary': { vocabulary: ['Quilt', 'Jewel360'], corrections: { 'bottle pause': 'Bottle POS' } },
    '/api/transcription-glossary/recent': { entries: [] } }
  const route = { pane: 'dictation', args: ['dictionary'] }
  it('while a refresh loads, the words stay (no skeleton)', async () => {
    const h = harness('dictation.js', 'pane-dictation', route, answers)
    await h.open()
    expect(h.pane.innerHTML).toContain('Jewel360')
    h.hold(); h.click('data-dict', 'refresh'); await h.flush()
    expect(h.pane.innerHTML).toContain('Jewel360')
    expect(h.pane.innerHTML).not.toContain(SKEL)
    await h.release(true)
    expect(h.pane.innerHTML).toContain('Jewel360')
  })
  it('a word being typed, and its focus and caret, survive the refresh', async () => {
    const h = harness('dictation.js', 'pane-dictation', route, answers)
    await h.open()
    h.type('#dict-term', 'Sprocket')
    h.click('data-dict', 'refresh'); await h.flush()
    const now = h.pane.querySelector('#dict-term') as El
    expect(now.value).toBe('Sprocket')
    expect(h.doc.activeElement).toBe(now)
    expect([now.selectionStart, now.selectionEnd]).toEqual([2, 2])
  })
  it('adding a word re-reads without going blank, and the box clears (not a refresh: nothing is kept)', async () => {
    const G = answers['/api/transcription-glossary']
    let slow = false, finish: (() => void) | null = null
    const a = { ...answers, '/api/transcription-glossary/vocabulary/add': {},
      '/api/transcription-glossary': () => slow ? new Promise(r => { finish = () => r(G) }) : G }
    const h = harness('dictation.js', 'pane-dictation', route, a)
    await h.open()
    h.type('#dict-term', 'Sprocket')
    slow = true
    h.pane.listeners.submit({ preventDefault: () => {}, target: { getAttribute: (k: string) => k === 'data-dict-form' ? 'vocab' : null } })
    await h.flush()
    expect(h.pane.innerHTML).toContain('Jewel360')
    expect(h.pane.innerHTML).not.toContain(SKEL)
    finish!(); await h.flush()
    expect((h.pane.querySelector('#dict-term') as El).value).toBe('')
  })
  it('a failed refresh keeps the words and says so in one line', async () => {
    const h = harness('dictation.js', 'pane-dictation', route, answers)
    await h.open()
    h.hold(); h.click('data-dict', 'refresh'); await h.flush(); await h.release(false)
    expect(h.pane.innerHTML).toContain('Jewel360')
    expect(h.pane.innerHTML).toMatch(FAIL)
    expect(h.pane.innerHTML).toMatch(/data-dict="refresh"[^>]*>Try again</)
  })
})

describe('Settings: Refresh keeps the settings and what is being typed', () => {
  const answers = { '/api/today/brief/settings': { enabled: true, dailyCap: 20, min: 1, max: 100 }, '/api/health': { status: 'ok' }, '/api/domains': { domains: [] } }
  const route = { pane: 'settings', args: [] }
  it('while a refresh loads, the settings stay (no skeleton)', async () => {
    const h = harness('settings.js', 'pane-settings', route, answers)
    await h.open()
    expect(h.pane.innerHTML).toContain('id="today-brief-cap"')
    h.hold(); h.click('data-set', 'refresh'); await h.flush()
    expect(h.pane.innerHTML).not.toContain(SKEL)
    expect(h.pane.innerHTML).toContain('id="today-brief-cap"')
    await h.release(true)
    expect(h.pane.innerHTML).toContain('id="today-brief-cap"')
  })
  it('a number being typed survives the refresh, with its focus', async () => {
    const h = harness('settings.js', 'pane-settings', route, answers)
    await h.open()
    h.type('#today-brief-cap', '35')
    h.click('data-set', 'refresh'); await h.flush()
    const now = h.pane.querySelector('#today-brief-cap') as El
    expect(now.value).toBe('35')
    expect(h.doc.activeElement).toBe(now)
  })
  it('a section whose read fails on refresh keeps what it showed', async () => {
    let fail = false
    const a = { ...answers, '/api/today/brief/settings': () => { if (fail) throw new Error('down'); return { enabled: true, dailyCap: 20, min: 1, max: 100 } } }
    const h = harness('settings.js', 'pane-settings', route, a)
    await h.open()
    fail = true
    h.click('data-set', 'refresh'); await h.flush()
    expect(h.pane.innerHTML).toContain('id="today-brief-cap"')
    expect(h.pane.innerHTML).toMatch(/id="today-brief-cap"[^>]*value="20"/)
  })
  it('a refresh where every read fails keeps the page and says so in one line', async () => {
    const h = harness('settings.js', 'pane-settings', route, answers)
    await h.open()
    h.hold(); h.click('data-set', 'refresh'); await h.flush(); await h.release(false)
    expect(h.pane.innerHTML).toContain('id="today-brief-cap"')
    expect(h.pane.innerHTML).toMatch(FAIL)
    expect(h.pane.innerHTML).toMatch(/data-set="refresh"[^>]*>Try again</)
  })
})
