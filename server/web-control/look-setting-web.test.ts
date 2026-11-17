/**
 * 7.0.53 (Miles 23:39, the lead's R3): Settings, This browser, Appearance gains a "Look" group, built exactly like the
 * theme rows (list rows with a check mark, no pills): "Amber" (the default) and "Espresso" (the look from before Amber).
 * It changes at once (theme.js CosLook, tested in amber-look-web.test.ts) and repaints its own checks.
 * Runs the real panes/settings.js in a vm, and app.js's own paintLook and click line.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SETTINGS = readFileSync(join(HERE, 'panes', 'settings.js'), 'utf8')
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')

async function render(look: string | null) {
  const pane = { innerHTML: '', addEventListener: () => {} }
  let loadFn: (() => void) | null = null
  const W = {
    $: (id: string) => (id === 'pane-settings' ? pane : null), esc: (s: unknown) => String(s), state: {}, skeletonRows: () => '', toast: () => {},
    parseRoute: () => ({ pane: 'settings', args: [] }), go: () => {},
    registerPane: (_n: string, def: { load: () => void }) => { loadFn = def.load },
    api: () => Promise.reject(new Error('404')),
  }
  const window: Record<string, unknown> = { COSWeb: W }
  if (look !== null) window.CosLook = { choice: () => look }
  vm.runInContext(SETTINGS, vm.createContext({ window, document: {}, console, Promise, Number, String, isFinite }))
  loadFn!()
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
  return pane.innerHTML
}
const rows = (html: string) => [...html.matchAll(/<button type="button" class="cx-set-row cx-set-choice" data-look-choice="([a-z]+)" aria-pressed="(true|false)"><span class="cx-set-name">([^<]+)<\/span><span class="value">([^<]*(?:<span class="check">✓<\/span>)?)<\/span><\/button>/g)]
  .map(m => ({ id: m[1], pressed: m[2], label: m[3], checked: m[4]!.includes('✓') }))

describe('Settings: the Look group', () => {
  it('two rows, Amber then Espresso, built like the theme rows, right after Appearance', async () => {
    const html = await render('amber')
    expect(rows(html)).toEqual([{ id: 'amber', pressed: 'true', label: 'Amber', checked: true }, { id: 'espresso', pressed: 'false', label: 'Espresso', checked: false }])
    const appearance = html.indexOf('Appearance'), look = html.indexOf('>Look<'), size = html.indexOf('Today summary size')
    expect(appearance).toBeGreaterThan(-1)
    expect(look).toBeGreaterThan(appearance)
    expect(look).toBeLessThan(size)
    // The same row class as the theme choices: no pill or segmented control.
    expect(html).toContain('data-theme-choice="system"')
    expect(html).not.toMatch(/data-look-choice="[a-z]+"[^>]*class="[^"]*(pill|seg|chip)/)
  })
  it('the check follows the stored look; with no CosLook (an old theme.js) Amber shows checked, the default', async () => {
    expect(rows(await render('espresso')).map(r => r.checked)).toEqual([false, true])
    expect(rows(await render(null)).map(r => r.checked)).toEqual([true, false])
  })
})

describe('app.js: a tap sets the look and repaints only the look rows', () => {
  it('the click line calls CosLook.set with the row\'s own choice, then paintLook, and the delegate reaches it', () => {
    const line = APP.split('\n').filter(l => l.includes("hasAttribute('data-look-choice')"))
    expect(line).toHaveLength(1)
    expect(line[0]).toContain("window.CosLook.set(t.getAttribute('data-look-choice')); paintLook(); return;")
    const delegate = APP.split('\n').filter(l => l.includes("var t = e.target.closest('[data-today-next]"))
    expect(delegate).toHaveLength(1)
    expect(delegate[0]).toContain('[data-look-choice]')
  })
  it('paintLook moves the check and aria-pressed to the chosen row', () => {
    const src = APP.slice(APP.indexOf('function paintLook()'), APP.indexOf('function paintStorySize()'))
    const mk = (id: string) => { const value = { innerHTML: '' }; const attrs: Record<string, string> = { 'data-look-choice': id }; return { attrs, value, getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v }, querySelector: () => value } }
    const btns = [mk('amber'), mk('espresso')]
    for (const [choice, want] of [['espresso', [false, true]], ['amber', [true, false]]] as const) {
      const window = { CosLook: { choice: () => choice } }
      const document = { querySelectorAll: (sel: string) => (sel === '[data-look-choice]' ? btns : []) }
      new Function('window', 'document', src + '\npaintLook();')(window, document)
      expect(btns.map(b => b.attrs['aria-pressed'] === 'true')).toEqual(want)
      expect(btns.map(b => b.value.innerHTML.includes('✓'))).toEqual(want)
    }
  })
})
