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

async function paint(status: unknown): Promise<string> {
  const el = { innerHTML: 'stale' }
  const ctx = vm.createContext({
    SX: { hooks: null, hooksAt: 0, hooksOffer: false },
    $: (id: string) => (id === 'sessions-hooks' ? el : null),
    esc: (s: unknown) => String(s),
    api: () => (status instanceof Error ? Promise.reject(status) : Promise.resolve(status)),
    Date,
  })
  vm.runInContext(SOURCE + '\nloadSessionHooks();', ctx)
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
  return el.innerHTML
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
})
