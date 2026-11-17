/** Amber is the default color layer (7.0.53, Miles 23:39); Espresso restores the look from before it. Layout and runtime behavior stay with the existing app.
 * These source/behavior guards do not replace F1's rendered, keyed WebKit sweep. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(HERE, 'amber.css'), 'utf8')
const THEME = readFileSync(join(HERE, 'theme.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const root = (mode: string) => `html[data-look='amber'][data-theme='${mode}']`
const COLOR_TOKENS = new Set(('page rail rail-border rail-active ink sub grey tertiary hot panel panel-border row-border qopen accent on-accent gold gold-bg btn-border btn-bg kbd-border run-bg run-border run-title run-sub run-open run-count run-line').split(' ').map(k => '--' + k))
const COLOR_PROPERTIES = new Set(['color', 'background', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke'])
type Rule = { selector: string; declarations: Record<string, string> }
function rules(css: string): Rule[] {
  let rest = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const result: Rule[] = []
  rest = rest.replace(/([^{}]+)\{([^{}]*)\}/g, (_all, selector, body) => {
    const declarations: Record<string, string> = {}
    for (const declaration of body.split(';').map((s: string) => s.trim()).filter(Boolean)) {
      const colon = declaration.indexOf(':')
      if (colon < 0) throw new Error('invalid declaration')
      const name = declaration.slice(0, colon).trim()
      if (name in declarations && !(name === '--gold-bg' && declarations[name]!.startsWith('rgba(') && declaration.slice(colon + 1).trim().startsWith('color-mix('))) throw new Error('duplicate declaration: ' + name)
      declarations[name] = norm(declaration.slice(colon + 1))
    }
    result.push({ selector: norm(selector), declarations })
    return ''
  })
  if (rest.trim()) throw new Error('unparsed CSS')
  if (!result.length) throw new Error('no rules')
  return result
}
function scoped(css: string) {
  const parsed = rules(css)
  for (const rule of parsed) for (const selector of rule.selector.split(',')) {
    if (!/^html\[data-look='amber'\]\[data-theme='(?:light|dark)'\]$/.test(selector.trim())) throw new Error('unscoped selector: ' + selector)
  }
  return parsed
}
function colorsOnly(css: string) {
  for (const { declarations } of rules(css)) for (const [name, value] of Object.entries(declarations)) {
    if (!(COLOR_TOKENS.has(name) || COLOR_PROPERTIES.has(name))) throw new Error('non-color property: ' + name)
    // A background shorthand or custom property must not smuggle dimensions, images, shadows or layout in.
    if (!/^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|var\(--[a-z-]+\)|color-mix\(in srgb, var\(--[a-z-]+\) \d+%, transparent\))$/i.test(value)) throw new Error('non-color value: ' + value)
  }
}
function palettes(css: string) {
  const parsed = rules(css)
  const get = (mode: string) => {
    const matches = parsed.filter(r => r.selector === root(mode))
    if (matches.length !== 1) throw new Error('one palette required: ' + mode)
    return matches[0]!.declarations
  }
  const light = get('light'), dark = get('dark')
  const keys = (p: Record<string, string>) => Object.keys(p).sort()
  if (JSON.stringify(keys(light)) !== JSON.stringify(keys(dark))) throw new Error('theme token parity')
  if (keys(light).length < 20) throw new Error('incomplete palette')
  return { light, dark }
}
function rgb(value: string): number[] {
  const m = /^#([0-9a-f]{6})$/i.exec(value)
  if (!m) throw new Error('expected opaque palette color: ' + value)
  return [0, 2, 4].map(i => parseInt(m[1]!.slice(i, i + 2), 16) / 255)
}
function luminance(value: number[]) { return value.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0) }
function contrast(a: string, b: string) { const x = luminance(rgb(a)), y = luminance(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
function readable(css: string) {
  // Applicable text pairs from A1's README; held glass/mark recipes are deliberately absent.
  for (const [mode, palette] of Object.entries(palettes(css))) {
    for (const [fg, bg] of [['accent', 'page'], ['sub', 'page'], ['sub', 'panel'], ['tertiary', 'page'], ['ink', 'page'], ['on-accent', 'accent'], ['run-sub', 'run-bg'], ['run-open', 'run-bg']]) {
      if (contrast(palette['--' + fg]!, palette['--' + bg]!) < 4.5) throw new Error(`${mode}: ${fg} on ${bg}`)
    }
  }
}
function themeRun(options: { store?: Record<string, string>; dark?: boolean; storageThrows?: boolean; writeThrows?: boolean; source?: string; calls?: string[] } = {}) {
  const store = { ...options.store }, attrs: Record<string, string> = {}, order: string[] = []
  let mediaChanged = () => {}
  const media = { matches: !!options.dark, addEventListener: (_type: string, fn: () => void) => { mediaChanged = fn } }
  const de = { setAttribute: (k: string, v: string) => { attrs[k] = v; order.push(k + '=' + v) }, hasAttribute: (k: string) => Object.hasOwn(attrs, k), removeAttribute: (k: string) => { delete attrs[k]; order.push('remove:' + k) }, classList: { add: (c: string) => order.push('class:' + c) } }
  const localStorage = {
    getItem: (key: string) => { if (options.storageThrows) throw new Error('SecurityError'); return store[key] ?? null },
    setItem: (key: string, value: string) => { if (options.storageThrows || options.writeThrows) throw new Error('QuotaExceededError'); store[key] = value },
    removeItem: (key: string) => { if (options.storageThrows) throw new Error('SecurityError'); delete store[key] },
  }
  const window: any = { matchMedia: () => media }
  const source = options.source ?? THEME
  const start = source.indexOf('/* Runs before first paint so the page never flashes')
  const end = source.indexOf('})();', start) + 5
  if (start < 0 || end <= start) throw new Error('theme block missing')
  // Every way out of the page, bound to a recorder: a look that reached one would show up in options.calls.
  const rec = (name: string) => (..._a: unknown[]) => { options.calls?.push(name) }
  const XHR = function () { options.calls?.push('XMLHttpRequest') }
  const consoleRec = { log: rec('console.log'), info: rec('console.info'), warn: rec('console.warn'), error: rec('console.error'), debug: rec('console.debug') }
  window.fetch = rec('fetch'); window.XMLHttpRequest = XHR; window.navigator = { sendBeacon: rec('sendBeacon') }; window.console = consoleRec
  // Q1 00:5x: every other way a page can send or leave: a cookie write, a socket, an image or event-stream request, a
  // message to another frame, and a navigation. Each is a recorder, so a mutant that uses one is named, never just thrown.
  const ctorRec = (name: string) => function (this: any) { options.calls?.push(name) } as unknown as new (...a: unknown[]) => unknown
  const WebSocketRec = ctorRec('WebSocket'), EventSourceRec = ctorRec('EventSource')
  const ImageRec = function (this: any) { options.calls?.push('Image'); Object.defineProperty(this, 'src', { set: () => { options.calls?.push('Image.src') } }) } as unknown as new () => unknown
  const doc: any = { documentElement: de }
  Object.defineProperty(doc, 'cookie', { get: () => '', set: () => { options.calls?.push('document.cookie') } })
  const location: any = { assign: rec('location.assign'), replace: rec('location.replace') }
  Object.defineProperty(location, 'href', { get: () => 'https://x/control/', set: () => { options.calls?.push('location.href') } })
  window.WebSocket = WebSocketRec; window.EventSource = EventSourceRec; window.Image = ImageRec; window.postMessage = rec('postMessage'); window.location = location
  window.parent = { postMessage: rec('parent.postMessage') }; window.top = window.parent
  new Function('window', 'document', 'localStorage', 'fetch', 'XMLHttpRequest', 'navigator', 'console', 'WebSocket', 'EventSource', 'Image', 'postMessage', 'location',
    source.slice(start, end))(window, doc, localStorage, window.fetch, XHR, window.navigator, consoleRec, WebSocketRec, EventSourceRec, ImageRec, window.postMessage, location)
  return { store, attrs, order, look: window.CosLook, theme: window.CosTheme, story: window.CosStorySize, changeSystem: (dark: boolean) => { media.matches = dark; mediaChanged() } }
}

describe('Amber scope and palette guards (mutants exercise each failure)', () => {
  it('every selector is opt-in; a bare rule or a selector-list escape is rejected', () => {
    expect(scoped(CSS).length).toBeGreaterThanOrEqual(2)
    for (const extra of ["html { color: #ffffff; }", "html[data-look='amber'][data-theme='light'], body { color: #ffffff; }"]) expect(() => scoped(CSS + extra)).toThrow(/unscoped/)
  })
  it('defers the whole embedded graph; even a scoped partial bridge is rejected', () => {
    const noGraph = (css: string) => { if (/\.(?:mm-graph|cgx-)/.test(css)) throw new Error('graph palette deferred') }
    noGraph(CSS)
    for (const selector of ['.mm-graph', '.cgx-btn.primary']) expect(() => noGraph(CSS + root('light') + ' ' + selector + ' { color: #ffffff; }')).toThrow(/deferred/)
  })
  it('allows color properties only, never size, spacing, images or layout custom properties', () => {
    colorsOnly(CSS)
    for (const extra of ['padding: 1px;', '--gutter: 1px;', 'background: url(/image.png);', 'box-shadow: 0 10px 20px #000000;']) expect(() => colorsOnly(CSS + root('light') + ' { ' + extra + ' }')).toThrow(/non-color/)
  })
  it('defines the same token set in light and dark; deleting one dark token is rejected', () => {
    palettes(CSS)
    const split = CSS.indexOf(root('dark'))
    const mutant = CSS.slice(0, split) + CSS.slice(split).replace(/\s*--accent:[^;]+;/, '')
    expect(() => palettes(mutant)).toThrow(/parity/)
  })
  it('reads contrast pairs from actual tokens; an unreadable accent is rejected', () => {
    readable(CSS)
    const palette = palettes(CSS).light
    expect(() => readable(CSS.replace('--accent: ' + palette['--accent'] + ';', '--accent: ' + palette['--page'] + ';'))).toThrow(/accent on page/)
  })
})

// 7.0.53 (Miles 23:39, the lead's R3): Amber is the DEFAULT; "Espresso" is the look from before Amber. These replace the
// 18:58 opt-in expectations (flipped on purpose, named in each title): nothing stored now means Amber.
describe('Amber is the default look; Espresso is chosen per device, before the first paint', () => {
  it('FLIPPED: no preference means Amber, set before fp-wait and cos-js; an Espresso-by-default mutant is rejected', () => {
    const assertAmber = (source: string) => {
      for (const dark of [false, true]) {
        const t = themeRun({ source, dark })
        expect(t.look.choice()).toBe('amber')
        expect(t.attrs).toMatchObject({ 'data-look': 'amber' })
        expect(t.order.indexOf('data-look=amber')).toBeLessThan(t.order.indexOf('class:fp-wait'))
        expect(t.store).toEqual({})
      }
    }
    assertAmber(THEME)
    const mutant = THEME.replace("localStorage.getItem(LOOK_KEY) === 'espresso' ? 'espresso' : 'amber'", "localStorage.getItem(LOOK_KEY) === 'amber' ? 'amber' : 'espresso'")
    expect(mutant).not.toBe(THEME)
    expect(() => assertAmber(mutant)).toThrow()
  })
  it('Espresso stored: no look attribute at all, so every Amber rule stays off and its first frame is Espresso', () => {
    for (const [choice, system, mode] of [['light', true, 'light'], ['dark', false, 'dark'], ['system', true, 'dark']] as const) {
      const t = themeRun({ store: { cos_web_look: 'espresso', cos_web_theme: choice }, dark: system })
      expect(t.look.choice()).toBe('espresso')
      expect(t.attrs).toEqual({ 'data-theme': mode })
      expect(t.order.some(s => s.includes('data-look'))).toBe(false)
    }
  })
  it('a device that stored amber under the opt-in keeps Amber', () => {
    expect(themeRun({ store: { cos_web_look: 'amber' } }).attrs['data-look']).toBe('amber')
  })
  it('FLIPPED: an unknown value or blocked storage is Amber, and the page still shows', () => {
    for (const value of ['', 'Amber', 'Espresso', 'toString', '__proto__', 'constructor', 'default', 'anything']) {
      const t = themeRun({ store: { cos_web_look: value } })
      expect(t.look.choice()).toBe('amber')
      expect(t.attrs['data-look']).toBe('amber')
    }
    const t = themeRun({ storageThrows: true, dark: true })
    expect(t.attrs).toEqual({ 'data-theme': 'dark', 'data-look': 'amber' })
    expect(t.order).toContain('class:cos-js')
    expect(() => t.look.set('espresso')).not.toThrow()
    expect(t.attrs).not.toHaveProperty('data-look')
    expect(() => t.look.set('amber')).not.toThrow()
    expect(t.attrs['data-look']).toBe('amber')
  })
  it('FLIPPED: Amber, Espresso, Amber at once and across reopening, each stored as he chose it, apart from theme and size', () => {
    const t = themeRun({ store: { cos_web_theme: 'dark', cos_web_story_size: 'small' } })
    expect(t.look.set('espresso')).toBe('espresso')
    expect(t.store.cos_web_look).toBe('espresso')
    expect(t.attrs).not.toHaveProperty('data-look')
    expect(themeRun({ store: t.store }).attrs).not.toHaveProperty('data-look')
    expect(t.look.set('amber')).toBe('amber')
    expect(t.store.cos_web_look).toBe('amber')
    expect(t.attrs['data-look']).toBe('amber')
    expect(themeRun({ store: t.store }).attrs['data-look']).toBe('amber')
    t.theme.set('light'); t.story.set('medium')
    expect(t.attrs).toMatchObject({ 'data-look': 'amber', 'data-theme': 'light', 'data-story-size': 'medium' })
    expect(t.store).toMatchObject({ cos_web_theme: 'light', cos_web_story_size: 'medium', cos_web_look: 'amber' })
    // Anything else asked for is Amber, the default; it never turns the look off.
    expect(t.look.set('__proto__')).toBe('amber')
    expect(t.attrs['data-look']).toBe('amber')
  })
  it('a refused write still changes the look, and the choice names what is on screen (Codex 00:00 P2)', () => {
    // Nothing stored, writes refused: Espresso is shown and named; the next open is Amber, the default.
    const t = themeRun({ writeThrows: true })
    expect(t.look.set('espresso')).toBe('espresso')
    expect(t.attrs).not.toHaveProperty('data-look')
    expect(t.look.choice()).toBe('espresso')
    expect(t.store).not.toHaveProperty('cos_web_look')
    // A stale saved Espresso and a refused write: Amber is shown and named, though storage still says espresso.
    const s = themeRun({ store: { cos_web_look: 'espresso' }, writeThrows: true })
    expect(s.look.choice()).toBe('espresso')
    expect(s.look.set('amber')).toBe('amber')
    expect(s.attrs['data-look']).toBe('amber')
    expect(s.look.choice()).toBe('amber')
    expect(s.store.cos_web_look).toBe('espresso')
    // Reads and writes both blocked: the same.
    const b = themeRun({ storageThrows: true })
    b.look.set('espresso')
    expect(b.look.choice()).toBe('espresso')
    expect(b.attrs).not.toHaveProperty('data-look')
  })
  it('a system theme change keeps the look', () => {
    for (const look of ['amber', 'espresso']) {
      const t = themeRun({ store: { cos_web_look: look }, dark: false })
      t.changeSystem(true)
      expect(t.attrs['data-theme']).toBe('dark')
      expect(t.attrs['data-look']).toBe(look === 'amber' ? 'amber' : undefined)
      t.changeSystem(false)
      expect(t.attrs['data-theme']).toBe('light')
    }
  })
})

// 7.0.53 (Miles 23:39: "do [not] want to break trust around privacy"): the look is kept in this browser only. Nothing is
// sent, set on the server, logged or counted, including a switch back to Espresso.
describe('the look makes no request, no server setting and no log line', () => {
  const APP = readFileSync(join(HERE, 'app.js'), 'utf8'), SETTINGS = readFileSync(join(HERE, 'panes', 'settings.js'), 'utf8')
  const NETWORK = /\bfetch\(|XMLHttpRequest|sendBeacon|\bapi\(|apiAnswer\(|clientLog|layoutCrumb|crumb\(|console\.|document\.cookie|WebSocket|EventSource|new Image\b|\.src\s*=|postMessage|\blocation\s*(\.(href|assign|replace)|=)|window\.open\(/
  it('opening and choosing a look call no request, beacon or console, in any order (a mutant that reports a revert is caught)', () => {
    const run = (source: string) => {
      const calls: string[] = []
      const t = themeRun({ source, calls, store: { cos_web_look: 'espresso' } })
      for (const choice of ['amber', 'espresso', 'amber']) t.look.set(choice)
      return calls
    }
    expect(run(THEME)).toEqual([])
    const reporting = THEME.replace("try { localStorage.setItem(LOOK_KEY, choice); } catch (_e) {}", "try { localStorage.setItem(LOOK_KEY, choice); } catch (_e) {} if (choice === 'espresso') fetch('/api/look-revert');")
    expect(reporting).not.toBe(THEME)
    expect(run(reporting)).toEqual(['fetch'])
    // Q1 00:5x: each other way out, planted in set() for a switch to Espresso, is named by the recorders.
    const plant = (code: string) => THEME.replace("try { localStorage.setItem(LOOK_KEY, choice); } catch (_e) {}", "try { localStorage.setItem(LOOK_KEY, choice); } catch (_e) {} if (choice === 'espresso') { " + code + " }")
    const ways: Array<[string, string[]]> = [
      ["document.cookie = 'look=' + choice;", ['document.cookie']],
      ["new WebSocket('wss://x/look');", ['WebSocket']],
      ["new Image().src = '/api/look?c=' + choice;", ['Image', 'Image.src']],
      ["new EventSource('/api/look');", ['EventSource']],
      ["window.parent.postMessage(choice, '*');", ['parent.postMessage']],
      ["postMessage(choice, '*');", ['postMessage']],
      ["location.href = '/api/look?c=' + choice;", ['location.href']],
      ["location.assign('/api/look');", ['location.assign']],
      ["navigator.sendBeacon('/api/look', choice);", ['sendBeacon']],
    ]
    for (const [code, want] of ways) {
      const mutant = plant(code)
      expect(mutant, code).not.toBe(THEME)
      expect(run(mutant), code).toEqual(want)
    }
  })
  it('the look code in theme.js, app.js and settings.js contains no request, server route or log call', () => {
    // Ends at the next block (fp-wait), never at a line inside the look code (Codex 00:1x: the old end marker moved
    // above window.CosLook with e9a47367, so set() fell outside the guard). It must hold the whole API.
    const lookBlock = THEME.slice(THEME.indexOf("var LOOK_KEY = 'cos_web_look';"), THEME.indexOf('// 7.0.19: the first paint'))
    expect(lookBlock.length).toBeGreaterThan(200)
    for (const part of ['function lookRead', 'function lookApply', 'window.CosLook', 'choice: function', 'set: function', 'localStorage.setItem(LOOK_KEY']) expect(lookBlock).toContain(part)
    // Q1 00:5x: the source pattern names each other way out too; each planted line is caught.
    for (const code of ["document.cookie = 'a';", "new WebSocket('w');", "new Image().src = 'u';", "x.src = 'u';", "new EventSource('e');", "postMessage(1, '*');", "location.href = 'u';", "location = 'u';", "location.assign('u');", "location.replace('u');", "window.open('u');"]) expect(code, code).toMatch(NETWORK)
    expect(lookBlock).not.toMatch(NETWORK)
    const paint = APP.slice(APP.indexOf('function paintLook()'), APP.indexOf('function paintStorySize()'))
    expect(paint.length).toBeGreaterThan(100)
    expect(paint).not.toMatch(NETWORK)
    const handler = APP.split('\n').filter(l => l.includes("hasAttribute('data-look-choice')"))
    expect(handler).toHaveLength(1)
    expect(handler[0]).not.toMatch(NETWORK)
    const rows = SETTINGS.slice(SETTINGS.indexOf('var look = window.CosLook'), SETTINGS.indexOf('var story = window.CosStorySize'))
    expect(rows.length).toBeGreaterThan(100)
    expect(rows).not.toMatch(NETWORK)
  })
})

// Critical token copies are byte-identical, not a second hand-maintained palette.
describe('Amber first paint before the optional stylesheet arrives', () => {
  it('mirrors both root blocks word for word and keeps all rules scoped', () => {
    const critical = /<style id="critical-css">([\s\S]*?)<\/style>/.exec(HTML)![1]!
    const block = (text: string, selector: string) => { const start = text.indexOf(selector + ' {'); if (start < 0) throw new Error('missing critical palette'); return text.slice(start, text.indexOf('}', start) + 1).replace(/\s+/g, ' ').trim() }
    for (const mode of ['light', 'dark']) expect(block(critical, root(mode))).toBe(block(CSS, root(mode)))
    const boot = JSON.parse(/id="boot-styles">([^<]*)<\/script>/.exec(HTML)![1]!)
    expect(boot).not.toContain('/control/amber.css')
    expect(JSON.parse(/id="amber-style">([^<]*)<\/script>/.exec(HTML)![1]!)).toBe('/control/amber.css')
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(HTML)![1]!
    expect(noscript).not.toContain('amber.css')
  })
})
