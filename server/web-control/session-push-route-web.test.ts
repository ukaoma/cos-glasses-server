import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
function cut(from: string, to: string) {
  const a = APP.indexOf(from), b = APP.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw Error('Production region missing: ' + from)
  return APP.slice(a, b)
}
function open(hash: string, savedView: string) {
  const lists: string[] = [], usage: string[] = [], crumbs: string[] = [], writes: unknown[] = []
  const saved = { view: savedView }
  const ctx = vm.createContext({ location: { hash }, ROOT_PANES: ['today', 'sessions', 'messages'], readStore: () => saved, writeStore: (...v: unknown[]) => writes.push(v),
    state: { sessions: [] }, Date, Promise,
    window: { COSWeb: { setCrumb: (s: string) => crumbs.push(s) } },
    paintSessionsHero() {}, renderUsageView: () => usage.push(ctx.SX.view), loadSessionHooks() {}, renderSessionGroups: () => lists.push(ctx.SX.view),
  })
  vm.runInContext(cut('  function parseRoute() {', '  function go(') + cut('  function isTabRoute(args) {', '\n') +
    cut("  var SX_PREFS = 'cos_web_sessions';", '  function sxProvider(') +
    cut('  function loadSessions(force) {', '  // The project most sessions share'), ctx)
  ctx.SX.rows = []; ctx.SX.loadedAt = Date.now()
  ctx.loadSessions()
  const route = ctx.parseRoute()
  return { lists, usage, crumbs, writes, view: ctx.SX.view, reading: route.args.length > 0 && !ctx.isTabRoute(route.args), saved }
}

describe('a session notification opens the existing explicit Sessions tab route', () => {
  for (const view of ['usage', 'cost', 'sessions']) {
    it(`#/sessions/t/sessions selects the list over saved ${view}, without opening a reader or changing the saved preference`, () => {
      const h = open('#/sessions/t/sessions', view)
      expect(h.view).toBe('sessions'); expect(h.lists).toEqual(['sessions']); expect(h.usage).toEqual([])
      expect(h.reading).toBe(false); expect(h.saved.view).toBe(view); expect(h.writes).toEqual([])
    })
    it(`ordinary #/sessions retains saved ${view}`, () => {
      const h = open('#/sessions', view)
      expect(h.view).toBe(view); expect(h.reading).toBe(false)
      expect(view === 'sessions' ? h.lists : h.usage).toEqual([view])
      expect(h.saved.view).toBe(view); expect(h.writes).toEqual([])
    })
  }
  it('an explicit session reader still selects Sessions and stays a reader', () => {
    const h = open('#/sessions/codex/fixture', 'cost')
    expect(h.view).toBe('sessions'); expect(h.reading).toBe(true)
  })
})
