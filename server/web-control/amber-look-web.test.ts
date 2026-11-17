/** Amber is an opt-in color layer. Layout and runtime behavior stay with the existing app.
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
function themeRun(options: { store?: Record<string, string>; dark?: boolean; storageThrows?: boolean; source?: string } = {}) {
  const store = { ...options.store }, attrs: Record<string, string> = {}, order: string[] = []
  let mediaChanged = () => {}
  const media = { matches: !!options.dark, addEventListener: (_type: string, fn: () => void) => { mediaChanged = fn } }
  const de = { setAttribute: (k: string, v: string) => { attrs[k] = v; order.push(k + '=' + v) }, hasAttribute: (k: string) => Object.hasOwn(attrs, k), removeAttribute: (k: string) => { delete attrs[k]; order.push('remove:' + k) }, classList: { add: (c: string) => order.push('class:' + c) } }
  const localStorage = {
    getItem: (key: string) => { if (options.storageThrows) throw new Error('SecurityError'); return store[key] ?? null },
    setItem: (key: string, value: string) => { if (options.storageThrows) throw new Error('SecurityError'); store[key] = value },
    removeItem: (key: string) => { if (options.storageThrows) throw new Error('SecurityError'); delete store[key] },
  }
  const window: any = { matchMedia: () => media }
  const source = options.source ?? THEME
  const start = source.indexOf('/* Runs before first paint so the page never flashes')
  const end = source.indexOf('})();', start) + 5
  if (start < 0 || end <= start) throw new Error('theme block missing')
  new Function('window', 'document', 'localStorage', source.slice(start, end))(window, { documentElement: de }, localStorage)
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

describe('Amber preference is per device and pre-paint, with the current default intact', () => {
  it('no preference means no look attribute or mutation; a default-on mutant is rejected', () => {
    const assertDefault = (source: string) => {
      const t = themeRun({ source })
      expect(t.look.choice()).toBe('default')
      expect(t.attrs).not.toHaveProperty('data-look')
      expect(t.order.some(s => s.includes('data-look'))).toBe(false)
      expect(t.store).toEqual({})
    }
    assertDefault(THEME)
    const mutant = THEME.replace("localStorage.getItem(LOOK_KEY) === 'amber'", "localStorage.getItem(LOOK_KEY) == null || localStorage.getItem(LOOK_KEY) === 'amber'")
    expect(mutant).not.toBe(THEME)
    expect(() => assertDefault(mutant)).toThrow()
  })
  it('a saved valid look is applied before fp-wait/cos-js, in explicit and system themes', () => {
    for (const [choice, system, mode] of [['light', true, 'light'], ['dark', false, 'dark'], ['system', true, 'dark']] as const) {
      const t = themeRun({ store: { cos_web_look: 'amber', cos_web_theme: choice }, dark: system })
      expect(t.attrs).toMatchObject({ 'data-look': 'amber', 'data-theme': mode })
      expect(t.order.indexOf('data-look=amber')).toBeLessThan(t.order.indexOf('class:fp-wait'))
    }
  })
  it('invalid values and blocked storage keep the default and still show the page', () => {
    for (const value of ['', 'Amber', 'toString', '__proto__', 'constructor', 'default', 'anything']) {
      const t = themeRun({ store: { cos_web_look: value } })
      expect(t.look.choice()).toBe('default')
      expect(t.attrs).not.toHaveProperty('data-look')
    }
    const t = themeRun({ storageThrows: true, dark: true })
    expect(t.attrs).toEqual({ 'data-theme': 'dark' })
    expect(t.order).toContain('class:cos-js')
    expect(() => t.look.set('amber')).not.toThrow()
    expect(t.attrs['data-look']).toBe('amber')
    expect(() => t.look.set('default')).not.toThrow()
    expect(t.attrs).not.toHaveProperty('data-look')
  })
  it('on → off → on persists independently of theme/story, and survives reopening', () => {
    const t = themeRun({ store: { cos_web_theme: 'dark', cos_web_story_size: 'small' } })
    expect(t.look.set('amber')).toBe('amber')
    expect(t.store.cos_web_look).toBe('amber')
    expect(themeRun({ store: t.store }).attrs['data-look']).toBe('amber')
    expect(t.look.set('default')).toBe('default')
    expect(t.store).not.toHaveProperty('cos_web_look')
    expect(t.attrs).not.toHaveProperty('data-look')
    expect(themeRun({ store: t.store }).attrs).not.toHaveProperty('data-look')
    t.look.set('amber'); t.theme.set('light'); t.story.set('medium')
    expect(t.attrs).toMatchObject({ 'data-look': 'amber', 'data-theme': 'light', 'data-story-size': 'medium' })
    expect(t.look.set('__proto__')).toBe('default')
    expect(t.attrs).not.toHaveProperty('data-look')
  })
  it('a system theme change preserves the chosen look', () => {
    const t = themeRun({ store: { cos_web_look: 'amber' }, dark: false })
    t.changeSystem(true)
    expect(t.attrs).toMatchObject({ 'data-look': 'amber', 'data-theme': 'dark' })
    t.changeSystem(false)
    expect(t.attrs).toMatchObject({ 'data-look': 'amber', 'data-theme': 'light' })
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
