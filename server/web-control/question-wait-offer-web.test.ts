// X1, 7.0.34: Control Web's Sessions hooks notice offers the 8 hour question wait, read-only, when the server says
// `sessionHooks.questionWait.offered`. Runs the REAL loadSessionHooks and paintHooks from app.js (cut out by their
// own markers) in a VM with the status call stubbed. A8 (Anand, "each thing once"): a hooks problem already says
// Reinstall hooks, so the offer never shows beside it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const START = APP.indexOf('  function loadSessionHooks() {')
const END = APP.indexOf('  // The view switch: Sessions | Usage | COS cost.')
const SOURCE = APP.slice(START, END)

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void }
function memoryStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}
const blockedStore: Store = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('SecurityError') } }

/** One page visit: runs the real functions, returns the painted HTML and a click on "Not now" if it is there. */
/** `storage`: a store, or null for a page with no localStorage at all. */
async function visit(status: unknown, storage: Store | null = memoryStore()) {
  const button = { onclick: null as null | (() => void) }
  const el = { innerHTML: 'stale', querySelector: (sel: string) => (sel === '[data-sx-offer="hide"]' && el.innerHTML.includes('data-sx-offer="hide"') ? button : null) }
  const ctx = vm.createContext({
    SX: { hooks: null, hooksAt: 0, hooksOffer: false, offerPutAway: false },
    $: (id: string) => (id === 'sessions-hooks' ? el : null),
    esc: (s: unknown) => String(s),
    api: () => (status instanceof Error ? Promise.reject(status) : Promise.resolve(status)),
    Date,
    ...(storage ? { localStorage: storage } : {}),
  })
  vm.runInContext(SOURCE + '\nloadSessionHooks();', ctx)
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
  return { el, notNow: button.onclick ? () => button.onclick!() : null }
}
async function paint(status: unknown, storage: Store | null = memoryStore()): Promise<string> {
  return (await visit(status, storage)).el.innerHTML
}
const hooks = (state: string, questionWait?: Record<string, unknown>) => ({ ok: true, sessionHooks: { state, ...(questionWait ? { questionWait } : {}) } })

describe('Control Web: the 8 hour question wait offer', () => {
  it('cut the real functions out of app.js', () => {
    expect(START).toBeGreaterThan(0)
    expect(END).toBeGreaterThan(START)
    expect(SOURCE).toContain('function paintHooks()')
  })

  it('installed and offered: one plain line, no dot, saying where to do it', async () => {
    const html = await paint(hooks('installed', { mode: 'default', offered: true }))
    expect(html).toContain('Questions can now wait up to 8 hours.')
    expect(html).toContain('In COS Control on your Mac, choose Reinstall hooks.')
    expect(html).not.toContain('sx-hooks-dot')
  })

  it('installed and not offered (on already, off, or an older server with no field): nothing', async () => {
    expect(await paint(hooks('installed', { mode: 'default', offered: false, active: true }))).toBe('')
    expect(await paint(hooks('installed', { mode: 'off', offered: false }))).toBe('')
    expect(await paint(hooks('installed'))).toBe('')
  })

  it('a hooks problem plus an offer: the problem line alone, with ONE "Reinstall hooks"', async () => {
    const html = await paint(hooks('drift', { mode: 'default', offered: true }))
    expect(html).toContain('needs a refresh')
    expect(html).not.toContain('8 hours')
    expect(html.split('Reinstall hooks').length - 1).toBe(1)
    const missing = await paint(hooks('missing', { mode: 'default', offered: true }))
    expect(missing).toContain('Install hooks')
    expect(missing).not.toContain('8 hours')
  })

  it('a failed status call shows no offer', async () => {
    expect(await paint(Object.assign(new Error('x'), { status: 500 }))).toBe('')
  })
  it('Not now puts the offer away in this browser: gone now, and on the next visit', async () => {
    const store = memoryStore()
    const offered = hooks('installed', { mode: 'default', offered: true })
    const first = await visit(offered, store)
    expect(first.el.innerHTML).toContain('Not now')
    expect(first.notNow).not.toBeNull()
    first.notNow!()
    expect(first.el.innerHTML).toBe('')
    expect(store.data.get('cos.sx.questionWaitOfferHidden')).toBe('1')
    expect(await paint(offered, store)).toBe('')
  })

  it('Not now never hides a hooks-problem line', async () => {
    const store = memoryStore()
    store.setItem('cos.sx.questionWaitOfferHidden', '1')
    const html = await paint(hooks('drift', { mode: 'default', offered: true }), store)
    expect(html).toContain('needs a refresh')
    expect(html).toContain('Reinstall hooks')
    expect(html).not.toContain('Not now')
  })

  it('a store that cannot be read or written: the line shows, Not now hides it for this visit, and it shows again next visit', async () => {
    const offered = hooks('installed', { mode: 'default', offered: true })
    const first = await visit(offered, blockedStore)
    expect(first.el.innerHTML).toContain('Questions can now wait up to 8 hours.')
    first.notNow!()
    expect(first.el.innerHTML).toBe('')
    expect(await paint(offered, blockedStore)).toContain('Questions can now wait up to 8 hours.')
    expect(await paint(offered, null)).toContain('Questions can now wait up to 8 hours.')
  })
})
