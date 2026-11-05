/**
 * 6.99.11 COS Control Web Settings, "COS reaching out": runs the real panes/settings.js in a vm with a fake COSWeb and
 * pane, and checks the gate, that every P2 setting has a control, and what a switch and a field send.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { mergeP2Settings, P2_DEFAULTS, type P2Settings } from '../lib/drop-p2-settings.js'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'settings.js'), 'utf8')

function leafPaths(o: unknown, prefix = ''): string[] {
  if (!o || typeof o !== 'object') return [prefix]
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
}

async function load(health: Record<string, unknown>, p2: P2Settings | null) {
  const listeners: Record<string, (e: unknown) => void> = {}
  const pane = { innerHTML: '', addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn } }
  const puts: unknown[] = []
  let current = p2
  const answers: Record<string, unknown> = { '/api/health': health }
  let loadFn: (() => void) | null = null
  const W = {
    $: (id: string) => id === 'pane-settings' ? pane : null, esc: (s: unknown) => String(s), state: {}, skeletonRows: () => '', toast: () => {},
    parseRoute: () => ({ pane: 'settings', args: [] }), go: () => {},
    registerPane: (_n: string, def: { load: () => void }) => { loadFn = def.load },
    api: (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path === '/api/drops/settings/p2') {
        if (opts?.method === 'PUT') { puts.push(opts.body); current = mergeP2Settings(current ?? P2_DEFAULTS, opts.body); return Promise.resolve({ protocol: 1, settings: current }) }
        return current ? Promise.resolve({ protocol: 1, settings: current }) : Promise.reject(new Error('404'))
      }
      return path in answers ? Promise.resolve(answers[path]) : Promise.reject(new Error('404'))
    },
  }
  const ctx = vm.createContext({ window: { COSWeb: W }, document: {}, console, Promise, Number, String, isFinite })
  vm.runInContext(SOURCE, ctx)
  loadFn!()
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
  return { pane, listeners, puts }
}
const target = (attrs: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const el: Record<string, unknown> = {
    ...extra, disabled: false,
    getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v },
  }
  el.closest = (sel: string) => (sel === '[data-set]' && attrs['data-set']) || (sel === '[data-p2]' && attrs['data-p2']) ? el : null
  return el
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)) }
const ON = { capabilities: { dropIt: { protocol: 1, enabled: true, source: 'settings', p2Settings: 1 } }, status: 'ok' }

describe('web Settings: COS reaching out', () => {
  it('is hidden without the capability, or with Drop it off', async () => {
    expect((await load({ capabilities: { dropIt: { protocol: 1, enabled: true, source: 'settings' } } }, P2_DEFAULTS)).pane.innerHTML).not.toContain('COS reaching out')
    expect((await load({ capabilities: { dropIt: { ...ON.capabilities.dropIt, enabled: false } } }, P2_DEFAULTS)).pane.innerHTML).not.toContain('COS reaching out')
    expect((await load(ON, null)).pane.innerHTML).not.toContain('COS reaching out')  // an older server: no settings route
  })

  it('has a control for every setting, and none of the AI telltales in its copy', async () => {
    const { pane } = await load(ON, P2_DEFAULTS)
    expect(pane.innerHTML).toContain('COS reaching out')
    // banners.reminder is the reminders.banners switch ("Notify me"); every other leaf has its own control.
    for (const path of leafPaths(P2_DEFAULTS).filter(p => p !== 'banners.reminder')) {
      expect(pane.innerHTML, path).toContain(`data-p2="${path}"`)
    }
    const section = pane.innerHTML.slice(pane.innerHTML.indexOf('COS reaching out'))
    expect(section).not.toMatch(/[—→]/)  // no em dashes or arrows
  })

  it('a switch sends just its field and flips; a field sends its value and shows what was saved', async () => {
    const h = await load(ON, P2_DEFAULTS)
    const sw = target({ 'data-set': 'p2', 'data-p2': 'pings.sources.prep', 'aria-checked': 'true' })
    h.listeners.click({ target: sw })
    await flush()
    expect(h.puts).toEqual([{ pings: { sources: { prep: false } } }])
    expect((sw.getAttribute as (k: string) => string)('aria-checked')).toBe('false')
    const num = target({ 'data-p2': 'pings.dailyCap' }, { type: 'number', tagName: 'INPUT', value: '50' })
    h.listeners.change({ target: num })
    await flush()
    expect(h.puts[1]).toEqual({ pings: { dailyCap: 50 } })
    expect(num.value).toBe('20')  // the server clamped it
    const day = target({ 'data-p2': 'checkin.weekday' }, { tagName: 'SELECT', value: '2' })
    h.listeners.change({ target: day })
    const steer = target({ 'data-p2': 'steer.leaveAlone' }, { tagName: 'TEXTAREA', value: 'HubDB' })
    h.listeners.change({ target: steer })
    await flush()
    expect(h.puts.slice(2)).toEqual([{ checkin: { weekday: 2 } }, { steer: { leaveAlone: 'HubDB' } }])
  })
})
