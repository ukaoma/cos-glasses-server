/** Recovery through the real Web pane and click handler. No server, provider or filesystem writes. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = (name: string) => readFileSync(new URL(`./panes/${name}.js`, import.meta.url), 'utf8')
const SID = 'meeting_prep_recovery'
const ID = 'prep_' + 'A'.repeat(26)
const START = Date.now() - 60_000
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }

// A small DOM: render slots and delegated clicks only. This gate makes no layout claims.
class Element {
  private html = ''
  listeners: Record<string, Function[]> = {}
  children: Element[] = []
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false }
  style = {}; hidden = false; textContent = ''; scrollTop = 0; scrollHeight = 0; clientHeight = 400; clientWidth = 0
  constructor(private ids: Map<string, Element>) {}
  set innerHTML(value: string) {
    this.html = value
    for (const m of value.matchAll(/\bid="([^"]+)"/g)) this.ids.set(m[1], new Element(this.ids))
  }
  get innerHTML() { return this.html }
  addEventListener(kind: string, fn: Function) { (this.listeners[kind] ??= []).push(fn) }
  contains() { return true }
  querySelector() { return null }
  querySelectorAll() { return [] }
  setAttribute() {}
  getAttribute() { return null }
  append(child: Element) { this.children.push(child) }
  insertBefore(child: Element) { this.children.push(child) }
  get firstChild() { return this.children[0] ?? null }
}

function draft(state = 'applying', options: { empty?: boolean; removed?: boolean; otherSession?: boolean } = {}) {
  return {
    id: ID, revision: 9, title: 'Pricing sync', startsAt: new Date(START).toISOString(),
    steer: options.empty ? '' : 'Later notes, not the saved bind', files: [], state: 'active', runs: [],
    bindings: [{ sessionId: options.otherSession ? 'meeting_other' : SID, serverInstanceId: 'server-A', revision: 4, state,
      removedAt: options.removed ? '2026-11-07T00:00:00Z' : null,
      snapshot: { draftRevision: 4, steer: 'Original pricing notes', files: [{ id: 'pf_original', name: 'Original.txt' }] } }],
  }
}

type Call = { path: string; method: string; body: any; headers: any }
async function open(offered: ReturnType<typeof draft>, responseState = 'applied') {
  const ids = new Map<string, Element>(), pane = new Element(ids)
  ids.set('pane-meetings', pane)
  const calls: Call[] = [], files: any[] = []
  const fetch = async (path: string, opts: any = {}) => {
    const call = { path, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers }
    calls.push(call)
    let body: any
    if (path.startsWith('/api/prep/suggest')) body = { serverInstanceId: 'server-A', drafts: [offered] }
    else if (path.startsWith('/api/meetings/live-chunks')) body = await api(path)
    else if (path.endsWith('/bind')) {
      if (responseState === 'applied') files.push({ id: 'prep_saved_notes', revision: 'r4', name: 'Prep notes', status: 'ready', text: 'Original pricing notes', origin: 'prep' },
        { id: 'prep_saved_file', revision: 'r4', name: 'Original.txt', status: 'ready', text: 'Original contents', origin: 'prep' })
      body = { draft: { ...offered, bindings: [{ ...offered.bindings[0], state: responseState, revision: call.body.revision }] }, files }
    } else throw new Error('Unexpected fetch: ' + path)
    return { status: 200, text: async () => JSON.stringify(body) }
  }
  const api = async (path: string) => {
    if (path === '/api/health') return { capabilities: { prep: { protocol: 1, bind: true, suggest: true, serverInstanceId: 'server-A' } } }
    if (path === '/api/meeting-ask/config') return { protocolVersion: 2, serverInstanceId: 'server-A', selected: { engine: 'claude', model: 'opus' }, models: [], capabilities: {} }
    if (path.startsWith('/api/meeting-ask/history')) return { exchanges: [], files, nextOffset: null }
    if (path.startsWith('/api/meetings/live-chunks')) return { sessions: [{ sessionId: SID, mtimeMs: Date.now() }], read: {
      sessionId: SID, startTime: START, lastActivityAt: Date.now(), ended: false, unchanged: false, fullSnapshot: true,
      stamp: '1', maxIndex: -1, settledThrough: -1, speakerRevision: '0', turns: [], levels: [],
    } }
    if (path.startsWith('/api/live-cues/history')) return { cues: [] }
    if (path.startsWith('/api/meeting-ask/context')) return {}
    throw new Error('Unexpected API: ' + path)
  }
  let registered: any
  const W: any = { $: (id: string) => ids.get(id) ?? null, api,
    esc: (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    setCrumb() {}, crumb: () => '', toast() {}, go() {}, copyText: async () => {}, readStore: () => ({}), writeStore() {},
    skeletonRows: () => '', showAuth() {}, autoGrow() {}, md: String, toDate: (v: string) => new Date(v),
    parseRoute: () => ({ pane: 'meetings', args: ['live', SID] }), registerPane: (_name: string, def: any) => { registered = def },
  }
  const document = { hidden: false, activeElement: null, body: { appendChild() {} }, documentElement: {},
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getElementById: W.$, createElement: () => new Element(ids) }
  const window = { COSWeb: W, navigator: { userAgent: 'Chrome' }, localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, getSelection: () => ({ isCollapsed: true }) }
  const context = vm.createContext({ window, document, navigator: window.navigator, localStorage: window.localStorage,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, crypto: globalThis.crypto,
    fetch, AbortController, URL, URLSearchParams, getComputedStyle: () => ({ getPropertyValue: () => '', overflowY: 'auto' }) })
  vm.runInContext(source('cos-chat'), context)
  vm.runInContext(source('meetings'), context)
  registered.load(['live', SID])
  await flush()
  const tap = async () => {
    const attrs: Record<string, string> = { 'data-mt': 'prep-bind', 'data-id': ID }
    const target = { disabled: false, getAttribute: (key: string) => attrs[key] ?? null }
    for (const fn of pane.listeners.click ?? []) fn({ target: { closest: () => target }, preventDefault() {} })
    await flush()
  }
  return { tap, calls, html: () => ids.get('mt-lprep')!.innerHTML, files: () => ids.get('mt-lfiles')!.innerHTML }
}

describe('Prep binding recovery after reopening the Web live meeting', () => {
  it('offers explicit recovery and retries the original binding revision, never the newer editable draft', async () => {
    const t = await open(draft())
    expect(t.html()).toContain('Retry add prep')
    expect(t.html()).not.toContain('No prep for this meeting')
    expect(t.html()).not.toContain('Added the prep')
    expect(t.calls.filter(c => c.path.startsWith('/api/prep/suggest'))).toHaveLength(1)
    expect(t.calls.filter(c => c.method === 'POST')).toEqual([])
    await t.tap()
    const binds = t.calls.filter(c => c.path.endsWith('/bind'))
    expect(binds).toHaveLength(1)
    expect(binds[0]).toMatchObject({ method: 'POST', headers: { 'X-COS-Expected-Server-Instance': 'server-A' },
      body: { revision: 4, sessionId: SID, serverInstanceId: 'server-A', surface: 'web' } })
    expect(t.files()).toContain('Original.txt')
    expect(t.files()).toContain('Prep notes')
    expect(t.files()).toContain('From prep')
    expect(t.html()).toContain('Added the prep for Pricing sync')
  })

  it('keeps recovery when later edits cleared the draft notes and files', async () => {
    const t = await open(draft('applying', { empty: true }))
    expect(t.html()).toContain('Retry add prep')
    await t.tap()
    expect(t.calls.find(c => c.method === 'POST')!.body.revision).toBe(4)
  })

  it('does not call an unconfirmed bind added, and keeps the retry available', async () => {
    const t = await open(draft(), 'applying')
    await t.tap()
    expect(t.html()).not.toContain('Added the prep')
    expect(t.html()).toContain('not confirmed')
    expect(t.html()).toContain('Retry add prep')
  })

  it('hides an applied binding but offers removed bindings and other meetings as fresh adds', async () => {
    const applied = await open(draft('applied'))
    expect(applied.html()).not.toContain('data-mt="prep-bind"')
    for (const options of [{ removed: true }, { otherSession: true }]) {
      const t = await open(draft('applying', options))
      expect(t.html()).toContain('Add to this meeting')
      expect(t.html()).not.toContain('Retry add prep')
      await t.tap()
      expect(t.calls.find(c => c.method === 'POST')!.body.revision).toBe(9)
    }
  })
})
