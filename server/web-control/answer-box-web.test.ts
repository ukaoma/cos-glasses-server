/**
 * 7.0.53 the Answer box (the lead's 23:5x: the smaller box first; ruling (c) 21:0x; X1_thread_reply_authority.md).
 *
 * Part 1 runs the SHARED send gates (app.js gateSend, gateWatch, gateVerdictHtml, gateAction) sliced out of app.js with
 * the reader's real send path (continueSession, parkTurn, apiAnswer, the binding store) and its sessionKit export,
 * against a fake fetch. Part 2 runs the real panes/cos-chat.js in a vm with that real kit as COSWeb.sessionKit, and drives
 * the box the way messages.js passes taps and submits on: Answer, words, Send, and what reaches the fake Mac.
 * Part 3 is the parity pin (ruling c): the gates' words are the reader's, and Today's differences are recorded, so drift
 * in any of the three fails here until the follow-up moves the reader and Today onto the gates.
 *
 * What only a browser proves (F1): the box's layout at 382, 449 and 951, the keyboard on the phone, and that the page
 * does not move when the box opens.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { derivedFields, listRow } from './session-row-fixture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CHAT = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const TODAY = readFileSync(join(HERE, 'panes', 'today-actions.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'panes', 'cos-chat.css'), 'utf8')
const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }

const TE = (() => {
  const a = APP.indexOf('  // ── A turn that ended asking you (7.0.18'), b = APP.indexOf('  function askedTitle(s) {', a)
  // eslint-disable-next-line no-new-func
  return new Function(APP.slice(a, b) + '\nreturn { TURN_END_PREFIX: TURN_END_PREFIX, TURN_END_QUOTE: TURN_END_QUOTE, isTurnEndAnswer: isTurnEndAnswer };')() as any
})()
const TRANSPORT = APP.slice(APP.indexOf('  // ── what every request learns about the Mac'), APP.indexOf('  // ── state ─'))

type Reply = { status: number; body: unknown } | Error
type Routes = Record<string, Reply | ((body: any, n: number) => Reply)>
function fakeFetch(routes: Routes) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  const fetch = (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const key = method + ' ' + path
    const n = calls.filter(c => c.method + ' ' + c.path === key).length
    const h = routes[key]
    const out = typeof h === 'function' ? h(body, n) : h ?? { status: 404, body: {} }
    if (out instanceof Error) return Promise.reject(out)
    return Promise.resolve({ status: out.status, ok: out.status >= 200 && out.status < 300, text: () => Promise.resolve(JSON.stringify(out.body)), json: () => Promise.resolve(out.body) })
  }
  return { fetch, calls }
}

/** The reader's send region and the sessionKit export, run as written. `doc.hidden` and the interval are the test's. */
function realKit(fetch: unknown, env: { hash?: string; trip?: unknown; ids?: () => Record<string, unknown> } = {}) {
  const start = APP.indexOf('  // ── Sessions: read, send, queue, fork, stop')
  const end = APP.indexOf("  // Copy session (Control's Kickstart brief")
  const ks = APP.indexOf('  window.COSWeb.sessionKit = {'), ke = APP.indexOf('\n  };', ks)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); expect(ks).toBeGreaterThan(0)
  const gates = APP.indexOf('  // ── the send gates, written once (7.0.53')
  expect(gates, 'the gates live inside the reader send region (the kit export reads them)').toBeGreaterThan(start)
  expect(gates).toBeLessThan(end)
  const kitExpr = APP.slice(ks, ke + 4).replace('  window.COSWeb.sessionKit = ', '').replace(/;\s*$/, '')
  const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
  const mdRegion = APP.slice(APP.indexOf('  // Markdown for an assistant turn'), APP.indexOf('  function renderTurns('))
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0] + '\n' + TRANSPORT
  const store = new Map<string, string>()
  const tabStore = new Map<string, string>()
  if (env.trip !== undefined) tabStore.set('cos.phoneTrip', JSON.stringify(env.trip))
  const replaced: string[] = []
  const ticks: Array<() => void> = []
  const doc = { hidden: false }
  const clock = { now: Date.now() }
  const FakeDate = class extends Date { static now() { return clock.now } }
  const deps: Record<string, unknown> = {
    state: { reading: null, turnPoll: null },
    $: (id: string) => (env.ids ? env.ids()[id] ?? null : null), esc, md: (s: unknown) => String(s), toDate: (v: unknown) => (v ? new Date(String(v)) : null), autoGrow: () => {}, showAuth: () => {},
    clock: (d: Date) => d.toISOString().slice(11, 16),
    fetch, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } },
    AbortController, setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length }, clearInterval: (i: number) => { if (i) ticks[i - 1] = () => {} },
    requestAnimationFrame: () => 0, document: doc,
    location: { hash: env.hash ?? '', pathname: '/control/', search: '', hostname: 'localhost', assign: () => {} },
    history: { state: null, replaceState: (_s: unknown, _t: string, u: string) => { replaced.push(u) } },
    sessionStorage: { getItem: (k: string) => tabStore.get(k) ?? null, setItem: (k: string, v: string) => { tabStore.set(k, v) }, removeItem: (k: string) => { tabStore.delete(k) } },
    readerKit: () => ({ webKeySigner: () => 0 }), window: { COSWeb: {}, scrollTo: () => {} }, Date: FakeDate,
    TURN_END_QUOTE: TE.TURN_END_QUOTE, TURN_END_PREFIX: TE.TURN_END_PREFIX, isTurnEndAnswer: TE.isTurnEndAnswer,
  }
  // eslint-disable-next-line no-new-func
  const kit = new Function('deps', 'with (deps) {\n' + plainFn + '\n' + sx + '\n' + mdRegion + '\n' + APP.slice(start, end) + '\nreturn ' + kitExpr + ';\n}')(deps)
  return { kit, doc, clock, tick: () => ticks.slice().forEach(f => f()), replaced, tabStore }
}

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', SID2 = '019a7b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b'
const P = (tail: string, id = SID) => `/api/agent-sessions/claude/${encodeURIComponent(id)}${tail}`
const OK: Routes = {
  // X1's must-fix: the box reads the session fresh at Send (idle here).
  ['GET ' + P('?turns=1')]: { status: 200, body: derivedFields('idle') },
  ['GET ' + P('?turns=1', SID2)]: { status: 200, body: derivedFields('idle') },
  ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: '', reasonCopy: '', ownerCount: 0 } },
  ['POST ' + P('/attach')]: { status: 201, body: { attached: true, bindingId: 'b1', epoch: 3 } },
  ['POST /api/agent-sessions/bindings/b1/turns']: { status: 202, body: { outcome: 'queued' } },
}
const turnPosts = (calls: Array<{ method: string; path: string; body: any }>) => calls.filter(c => c.method === 'POST' && /\/bindings\/[^/]+\/turns$/.test(c.path))

/** A view that records what the gates tell it, as the thread box's does. */
function recView() {
  const log: Array<[string, ...unknown[]]> = []
  const view = {
    status: (_r: unknown, t: string, k?: string) => log.push(['status', t, k ?? '']), pending: (_r: unknown, t: string, n: string) => log.push(['pending', t, n]),
    clear: (_r: unknown, t: string) => log.push(['clear', t]), verdict: () => log.push(['verdict']), stateChanged: () => log.push(['stateChanged']),
    hold: () => log.push(['hold']), watch: (r: any, b: string, k: string) => log.push(['watch', b, k]), queue: () => log.push(['queue']),
    live: () => true, sending: (_r: unknown, on: boolean) => log.push(['sending', on]),
  }
  const last = (kind: string) => [...log].reverse().find(l => l[0] === kind)
  return { view, log, last }
}

// ── Part 1: the shared gates, in the reader's order ─────────────────────────────────────────────────────────────────
describe('the shared gates stop a send in the reader\'s order, and send nothing until each passes', () => {
  it('no words: "Write a message first.", nothing sent', async () => {
    const { fetch, calls } = fakeFetch(OK), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    expect(await kit.gates.send(r, '   \n ', {})).toBe('empty')
    expect(v.last('status')).toEqual(['status', 'Write a message first.', 'error'])
    expect(calls).toHaveLength(0)
  })
  it('a file still uploading or one that failed stops it, in the reader\'s words', async () => {
    const { fetch, calls } = fakeFetch(OK), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    expect(await kit.gates.send(r, 'hi', { files: { state: 'waiting' } })).toBe('uploading')
    expect(v.last('status')).toEqual(['status', 'A file is still uploading. Send when it finishes.', ''])
    expect(await kit.gates.send(r, 'hi', { files: { state: 'failed' } })).toBe('file-failed')
    expect(v.last('status')).toEqual(['status', 'A file did not upload. Retry it or remove it.', 'error'])
    expect(calls).toHaveLength(0)
  })
  it('the caution is asked before the first send, and Send anyway sends it once; Cancel sends nothing', async () => {
    const { fetch, calls } = fakeFetch(OK), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    r.verdict = { attachable: true, caution: true, reason: '', reasonCopy: '', ownerCount: 1 }
    expect(await kit.gates.send(r, 'Ship it.', {})).toBe('caution')
    expect(calls).toHaveLength(0)
    const html = kit.gates.verdictHtml(r, '', ' data-x="1"')
    expect(html).toContain('<strong>Send into an open session?</strong>')
    expect(html).toContain('data-gate="caution-send" data-x="1">Send anyway</button>')
    expect(html).toContain('data-gate="caution-cancel" data-x="1">Cancel</button>')
    expect(await kit.gates.action(r, 'caution-cancel', () => Promise.resolve('x'))).toBe('cancelled')
    expect(r.cautionAsk).toBe(false)
    expect(calls).toHaveLength(0)
    const resend = (o: object) => kit.gates.send(r, 'Ship it.', o)
    expect(await kit.gates.send(r, 'Ship it.', {})).toBe('caution')
    expect(await kit.gates.action(r, 'caution-send', resend)).toBe('sent')
    expect(turnPosts(calls)).toHaveLength(1)
    // Asked once: the next message goes without asking.
    expect(await kit.gates.send(r, 'And the notes.', {})).toBe('sent')
    expect(turnPosts(calls)).toHaveLength(2)
  })
  it('one send at a time: a second Send while the first is on its way posts nothing', async () => {
    let release!: () => void
    const routes: Routes = { ...OK, ['POST ' + P('/attach')]: () => ({ status: 201, body: { attached: true, bindingId: 'b1', epoch: 3 } }) }
    const { fetch: base, calls } = fakeFetch(routes)
    const gate = new Promise<void>(res => { release = res })
    const slow = (p: string, i?: any) => (/\/attach$/.test(p) ? gate.then(() => base(p, i)) : base(p, i))
    const { kit } = realKit(slow), v = recView(), r = kit.session('claude', SID, v.view)
    const first = kit.gates.send(r, 'One.', {})
    expect(await kit.gates.send(r, 'One.', {})).toBe('busy')
    release(); expect(await first).toBe('sent')
    expect(turnPosts(calls)).toHaveLength(1)
    expect(v.log.filter(l => l[0] === 'sending').map(l => l[1])).toEqual([true, false])
  })
  it('sent: his words exactly as written (trimmed), to the session\'s own binding, never through COS; the box clears and the turn is watched', async () => {
    const { fetch, calls } = fakeFetch(OK), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    const words = 'Yes, publish to next.\n\nThen tell me the version.'
    expect(await kit.gates.send(r, '  ' + words + '  ', {})).toBe('sent')
    expect(calls.map(c => c.method + ' ' + c.path)).toEqual(['POST ' + P('/attach'), 'POST /api/agent-sessions/bindings/b1/turns'])
    const body = turnPosts(calls)[0]!.body
    expect(body.prompt).toBe(words)
    expect(body).not.toHaveProperty('seen')
    expect(body).not.toHaveProperty('acknowledgedRevision')
    expect(calls.some(c => /\/api\/(cos|ask|chat|inbox)/.test(c.path))).toBe(false)
    expect(v.last('clear')).toEqual(['clear', words])
    expect(v.last('status')).toEqual(['status', 'Sent. Watching for the reply.', ''])
    expect(v.last('watch')).toEqual(['watch', 'b1', body.clientTurnId])
  })
  it('a lost answer: the box says so with Retry, and Retry sends the SAME key (it will not post twice)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const routes: Routes = { ...OK, ['POST /api/agent-sessions/bindings/b1/turns']: (_b, n) => (n === 1 ? abort : { status: 202, body: { outcome: 'queued', replayed: true } }) }
    const { fetch, calls } = fakeFetch(routes), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    expect(await kit.gates.send(r, 'Go.', {})).toBe('lost')
    expect(r.refusal).toEqual({ copy: 'No answer from your Mac yet. It may still land. Sending again is safe; it will not post twice.', retry: true })
    const html = kit.gates.verdictHtml(r, '<b>open</b>', '')
    expect(html).toContain('data-gate="retry">Retry</button>')
    expect(html).not.toContain('<b>open</b>')
    expect(await kit.gates.action(r, 'retry', (o: object) => kit.gates.send(r, 'Go.', o))).toBe('sent')
    const posts = turnPosts(calls)
    expect(posts).toHaveLength(2)
    expect(posts[1]!.body.clientTurnId).toBe(posts[0]!.body.clientTurnId)
    expect(v.last('status')).toEqual(['status', 'Already sent. Watching for the reply.', ''])
  })
  it('the session changed: never resent by itself; the box shows Send it anyway, which carries that refusal\'s revision', async () => {
    const routes: Routes = { ...OK, ['POST /api/agent-sessions/bindings/b1/turns']: (_b, n) => (n === 1 ? { status: 409, body: { outcome: 'refused', reason: 'native_thread_changed', revision: 'rev-7' } } : { status: 202, body: { outcome: 'queued' } }) }
    const { fetch, calls } = fakeFetch(routes), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    expect(await kit.gates.send(r, 'Go.', {})).toBe('changed')
    expect(turnPosts(calls)).toHaveLength(1)
    expect(r.refusal.copy).toBe('This session changed on your Mac since you opened it.')
    const html = kit.gates.verdictHtml(r, '<button data-open>Open the session</button>', '')
    expect(html).toContain('data-gate="send-anyway">Send it anyway</button>')
    expect(html).toContain('<button data-open>Open the session</button>')
    expect(html).not.toContain('fork-session')
    expect(await kit.gates.action(r, 'send-anyway', (o: object) => kit.gates.send(r, 'Go.', o))).toBe('sent')
    const second = turnPosts(calls)[1]!.body
    expect(second.acknowledgedRevision).toBe('rev-7')
    // A plain Send after that carries no revision (the tap is spent).
    expect(r.sendAnyway).toBe(null)
  })
  it('busy: waiting in line, through the server\'s queue, cleared from the box', async () => {
    const routes: Routes = { ...OK, ['POST ' + P('/attach')]: { status: 409, body: { attached: false, reason: 'native_thread_working', reasonCopy: 'Working.' } },
      ['POST ' + P('/queued-turns')]: { status: 201, body: { queued: true, position: 1 } } }
    const { fetch, calls } = fakeFetch(routes), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    expect(await kit.gates.send(r, 'Later is fine.', {})).toBe('parked')
    expect(calls.find(c => c.path === P('/queued-turns'))!.body.prompt).toBe('Later is fine.')
    expect(v.last('clear')).toEqual(['clear', 'Later is fine.'])
  })
  it('a session that cannot be written to: the server\'s words, and the caller\'s way in where the reader offers Fork', async () => {
    const routes: Routes = { ...OK, ['POST ' + P('/attach')]: { status: 409, body: { attached: false, reason: 'binding_refused_owner', reasonCopy: 'Another device holds this session.' } } }
    const { fetch, calls } = fakeFetch(routes), { kit } = realKit(fetch), v = recView(), r = kit.session('claude', SID, v.view)
    expect(await kit.gates.send(r, 'Hi.', {})).toBe('refused')
    expect(turnPosts(calls)).toHaveLength(0)
    const html = kit.gates.verdictHtml(r, '<button data-open>Open the session</button>', '')
    expect(html).toContain('<p>Another device holds this session.</p>')
    expect(html).toContain('<button data-open>Open the session</button>')
    expect(html).not.toContain('Fork')
  })
  it('the standing caution line is the reader\'s, per provider; none without a caution', () => {
    const { kit } = realKit(fakeFetch(OK).fetch)
    const r = kit.session('claude', SID, recView().view), c = kit.session('codex', SID, recView().view)
    expect(kit.gates.caution(r)).toBe('')
    r.verdict = { caution: true }; c.verdict = { caution: true }
    expect(kit.gates.caution(r)).toBe('Another app on this Mac has this session open. COS will ask before the first send. The reply lands in the transcript; the open desk tab will not show it until you resume.')
    expect(kit.gates.caution(c)).toBe('The Codex app has this thread open. COS will ask before the first send, then hands your message to the app’s own queue, where it shows.')
  })
})

describe('the 3-minute watch: the reader\'s outcomes, paused while the page is hidden', () => {
  const watchKit = (outcome: unknown) => {
    const routes: Routes = { ...OK, ['GET /api/agent-sessions/bindings/b1/turns/k1']: () => outcome as Reply }
    const f = fakeFetch(routes), K = realKit(f.fetch), v = recView(), r = K.kit.session('claude', SID, v.view)
    return { ...K, ...f, v, r }
  }
  it('done, sent into the open session, refused, and cannot tell: each in the reader\'s words', async () => {
    for (const [body, said, kind] of [
      [{ outcome: 'completed' }, 'Done.', ''], [{ outcome: 'completed', via: 'live' }, 'Sent into the open session.', ''],
      [{ outcome: 'refused' }, 'The session refused that message.', 'error'], [{ outcome: 'ambiguous' }, 'COS cannot tell whether that landed. Look at the session before sending it again.', 'error'],
    ] as const) {
      const w = watchKit({ status: 200, body })
      w.kit.gates.watch(w.r, 'b1', 'k1'); w.tick(); await flush()
      expect(w.v.last('status')).toEqual(['status', said, kind])
    }
  })
  it('hidden: no reads, and the three minutes count only while the page is in view; past them, no reads', async () => {
    const w = watchKit({ status: 200, body: { outcome: 'queued' } })
    w.kit.gates.watch(w.r, 'b1', 'k1')
    w.doc.hidden = true
    for (let i = 0; i < 100; i++) { w.clock.now += 3000; w.tick() }   // five minutes hidden
    await flush()
    expect(w.calls).toHaveLength(0)
    w.doc.hidden = false
    w.clock.now += 3000; w.tick(); await flush()
    expect(w.calls).toHaveLength(1)
    w.clock.now += 181000; w.tick(); w.tick(); await flush()
    expect(w.calls).toHaveLength(1)
  })
  it('stops when its box is gone (view.live false)', async () => {
    const w = watchKit({ status: 200, body: { outcome: 'queued' } })
    w.v.view.live = () => false
    w.kit.gates.watch(w.r, 'b1', 'k1'); w.tick(); await flush()
    expect(w.calls).toHaveLength(0)
  })
})

// ── Part 2: the box in the thread, the real cos-chat.js on the real gates ───────────────────────────────────────────
class El {
  attrs: Record<string, string> = {}; id = ''; value = ''; textContent = ''; innerHTML = ''; disabled = false; readOnly = false
  cls = new Set<string>()
  classList = { add: (c: string) => this.cls.add(c), remove: (c: string) => this.cls.delete(c), contains: (c: string) => this.cls.has(c), toggle: (c: string, on?: boolean) => ((on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c)) }
  constructor(public tag = 'DIV', public doc?: { activeElement: unknown }) {}
  get tagName() { return this.tag }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v) }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k]! : null }
  hasAttribute(k: string) { return k in this.attrs }
  focusOpts: unknown = undefined
  focus(o?: unknown) { this.focusOpts = o; if (this.doc) this.doc.activeElement = this }
}
class FormEl extends El {
  input: El; note: El; verdict: El; caution: El; send: El; close: El
  constructor(doc: { activeElement: unknown }) {
    super('FORM', doc)
    this.input = new El('TEXTAREA', doc); this.note = new El('P', doc); this.verdict = new El('DIV', doc); this.caution = new El('P', doc)
    this.send = new El('BUTTON', doc); this.close = new El('BUTTON', doc)
  }
  set html(_v: string) {}
  querySelector(s: string) {
    if (s === '[data-cos-rr-input]') return this.input
    if (s === '[data-rr-note]') return this.note
    if (s === '[data-rr-verdict]') return this.verdict
    if (s === '[data-rr-caution]') return this.caution
    return null
  }
  querySelectorAll(s: string) { return s === 'button' ? [this.send, this.close] : [] }
  contains(el: unknown) { return el === this || [this.input, this.note, this.verdict, this.caution, this.send, this.close].includes(el as El) }
  closest(s: string) { return s === '[data-cos-rr-answer]' ? this : null }
}

const A_KEY = 'claude|' + SID, B_KEY = 'claude|' + SID2
let itemN = 0
function rr(o: { sid?: string; excerpt?: string; at?: string } = {}) {
  const sid = o.sid ?? SID, id = 'fi_' + (++itemN)
  return { id, kind: 'ping', threadId: id, createdAt: o.at ?? new Date(Date.now() - 240000).toISOString(), readAt: null, source: 'cos', title: 'Reply ready',
    line: 'Claude has a reply ready.', links: [{ kind: 'session', id: sid, label: 'Release checks', provider: 'claude' }], actions: [{ id: 'open_result', label: 'Open result' }],
    state: 'live', key: `agent:${sid}:turn:${'a'.repeat(63)}${itemN % 10}`, excerpt: o.excerpt ?? 'All gates passed. Publish to next?', turnAt: o.at ?? new Date(Date.now() - 240000).toISOString() }
}

function thread(o: { routes?: Routes; noKit?: boolean; sessions?: unknown[]; hash?: string; trip?: unknown; card?: { id: string; top: number; shift: number } } = {}) {
  const forms: FormEl[] = []
  const ids = () => { const fe = forms[forms.length - 1]; return fe ? { 'rr-form': fe, 'rr-input': fe.input, 'rr-send': fe.send } : {} }
  const f = fakeFetch(o.routes ?? OK), K = realKit(f.fetch, { hash: o.hash, trip: o.trip, ids })
  const document: any = { activeElement: null, hidden: false, addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null, body: { scrollHeight: 0 }, scrollingElement: {} }
  document.createElement = (tag: string) => { if (tag === 'form') { const fe = new FormEl(document); forms.push(fe); return fe } return { setAttribute() {}, classList: { add() {} } } }
  let html = '', paints = 0
  const placed: Record<string, unknown> = {}
  const goBtn = new El('BUTTON', document)
  let cardTop = o.card ? o.card.top : 0
  const card = { getAttribute: (k: string) => (k === 'data-item-id' && o.card ? o.card.id : null), hasAttribute: (k: string) => k === 'data-item-id',
    getBoundingClientRect: () => ({ top: cardTop, bottom: cardTop + 100 }) }
  const feed = {
    get innerHTML() { return html },
    // o.card: one card on screen at o.card.top; each paint after the first moves it by o.card.shift (a box above it went).
    // As in a browser: the old feed goes, and focus inside it is lost.
    set innerHTML(v: string) { html = v; paints++; if (o.card && paints > 1) cardTop += o.card.shift; for (const k of Object.keys(placed)) { if ((placed[k] as FormEl).contains(document.activeElement)) document.activeElement = null; delete placed[k] } },
    contains: (el: unknown) => Object.values(placed).some(n => (n as FormEl).contains(el)),
    querySelector: (s: string) => {
      const m = /^\[data-rr-answer-slot="(.+)"\]$/.exec(s)
      if (m && html.includes('data-rr-answer-slot="' + esc(m[1]) + '"')) return { appendChild: (n: unknown) => { placed[m[1]!] = n } }
      if (o.card && s === '[data-item-id="' + o.card.id + '"]') return card
      return null
    },
    querySelectorAll: (s: string) => (o.card && s.includes('[data-item-id]') ? [card] : []), scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  }
  const host = { querySelector: (s: string) => (s === '[data-cos-feed]' ? feed : /^\[data-rr-row=/.test(s) ? { querySelector: () => goBtn } : null) }
  const W: Record<string, unknown> = {
    $: () => null, esc, toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d }, readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {}, api: () => Promise.resolve({}),
    ...(o.noKit ? {} : { sessionKit: K.kit }),
  }
  const scrolls: unknown[][] = []
  const window = { COSWeb: W, matchMedia: () => ({ matches: false, addEventListener: () => {} }), scrollTo: (...a: unknown[]) => { scrolls.push(a) }, scrollBy: (...a: unknown[]) => { scrolls.push(['by', ...a]) }, localStorage: { getItem: () => null, setItem: () => {} } }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(CHAT, ctx)
  const chat = W.cosChat as any
  Object.assign(chat._state, { host, caps: { jobs: true, dropIt: true }, feedMode: 'drop', feedState: 'ready' })
  const paint = (items: unknown[]) => { chat._state.items = items; chat._paintFeed(true); return html }
  const tap = (attrs: Record<string, string>) => chat.onClick({ getAttribute: (k: string) => attrs[k] ?? null, tagName: 'BUTTON' })
  const submit = (form: FormEl) => { let prevented = false; const handled = chat.onSubmit({ target: form, preventDefault: () => { prevented = true } }); return { handled, prevented } }
  const type = (form: FormEl, words: string) => { form.input.value = words; chat.onInput({ target: { ...form.input, hasAttribute: (k: string) => k === 'data-cos-rr-input', getAttribute: (k: string) => (k === 'data-cos-rr-input' ? form.getAttribute('data-cos-rr-answer') : null), value: words } }) }
  return { chat, paint, tap, submit, type, forms, placed, html: () => html, paints: () => paints, document, goBtn, scrolls, ...f, K }
}

describe('Answer on a Reply ready row', () => {
  it('only where it works: no Answer without the shared gates (no dead control), none while the session waits on an approval', () => {
    expect(thread({ noKit: true }).paint([rr()])).not.toContain('data-cos="rr-answer"')
    const t = thread()
    expect(t.paint([rr()])).toContain('<button type="button" class="link-btn rr-answer-go" data-cos="rr-answer" data-rr="' + esc(A_KEY) + '" aria-expanded="false">Answer</button>')
    t.chat._state.sessionRows = [listRow({ id: SID, agentState: 'waiting', derived: { waiting_kind: 'permission' } })]
    const waiting = t.paint([rr()])
    expect(waiting).not.toContain('data-cos="rr-answer"')
    expect(waiting).toContain('It asked for approval.')
  })
  it('opens an EMPTY box under its row, addressed to that one session, labelled as the reader\'s message-only send', async () => {
    const t = thread()
    t.paint([rr({ excerpt: 'Publish 7.0.53 to next? Say yes and I will.' })])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    expect(t.forms).toHaveLength(1)
    const f = t.forms[0]!
    expect(f.input.value).toBe('')
    expect(f.innerHTML).toContain('To <strong><bdi>Release checks</bdi></strong>, Claude, <span class="rr-id">0a1b2c3d</span>')
    expect(f.innerHTML).toContain('>Send as message only</button>')
    // The phone composer finds the box by these (prefix rr): one box at a time keeps them unique.
    expect(f.id).toBe('rr-form')
    expect(f.innerHTML).toContain('id="rr-input"')
    expect(f.innerHTML).toContain('<button type="submit" class="cx-btn" id="rr-send" data-rr-send>')
    expect(f.innerHTML).toContain('placeholder="Message this session"')
    // No prefill and no chips: nothing of the reply's text is in the box.
    expect(f.innerHTML).not.toContain('Publish 7.0.53')
    expect(f.innerHTML).not.toMatch(/chip|data-prefill/)
    expect(t.html()).toContain('data-rr-answer-slot="' + esc(A_KEY) + '"')
    expect(t.placed[A_KEY]).toBe(f)
    expect(t.html()).toContain('aria-expanded="true">Answer</button>')
    expect(t.document.activeElement).toBe(f.input)
    // It asks the Mac what the session takes right now (the caution), as the reader does.
    await flush()
    expect(t.calls.map(c => c.method + ' ' + c.path)).toEqual(['GET ' + P('/attachability')])
  })
  it('Send: his words reach that session\'s own binding as written, the box clears, and the gates\' words show', async () => {
    const t = thread()
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    const f = t.forms[0]!
    t.type(f, 'Yes. Publish to next.')
    expect(t.submit(f)).toEqual({ handled: true, prevented: true })
    await flush()
    const post = turnPosts(t.calls)
    expect(post).toHaveLength(1)
    expect(post[0]!.body.prompt).toBe('Yes. Publish to next.')
    expect(t.calls.find(c => c.method === 'POST' && c.path === P('/attach'))).toBeTruthy()
    expect(f.input.value).toBe('')
    expect(f.note.textContent).toBe('Sent. Watching for the reply.')
    expect(t.chat._state.ansDraft[A_KEY]).toBeUndefined()
  })
  it('the same words sent again are a new message with a key of its own (the reader\'s clear drops the draft too)', async () => {
    const t = thread()
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    const f = t.forms[0]!
    t.type(f, 'Yes.'); t.submit(f); await flush()
    t.type(f, 'Yes.'); t.submit(f); await flush()
    const keys = turnPosts(t.calls).map(c => c.body.clientTurnId)
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })
  it('while it sends, the box\'s buttons are off and its words read-only; after, both come back', async () => {
    const t = thread()
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    const f = t.forms[0]!
    t.type(f, 'Go.')
    t.submit(f)
    // The gate marks it sending before the first request goes out.
    expect([f.send.disabled, f.close.disabled, f.input.readOnly]).toEqual([true, true, true])
    await flush()
    expect(turnPosts(t.calls)).toHaveLength(1)
    expect([f.send.disabled, f.close.disabled, f.input.readOnly]).toEqual([false, false, false])
  })
  it('an empty box sends nothing and says why', async () => {
    const t = thread()
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.submit(t.forms[0]!); await flush()
    expect(turnPosts(t.calls)).toHaveLength(0)
    expect(t.forms[0]!.note.textContent).toBe('Write a message first.')
    expect(t.forms[0]!.note.cls.has('error')).toBe(true)
    // No words, no read of the Mac.
    expect(t.calls.filter(c => c.path === P('?turns=1'))).toHaveLength(0)
  })
  it('the caution from the Mac shows its line, then asks at Send; Send anyway (routed by data-cos) sends once', async () => {
    const routes: Routes = { ...OK, ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: '', reasonCopy: '', ownerCount: 1 } } }
    const t = thread({ routes })
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY }); await flush()
    const f = t.forms[0]!
    expect(f.caution.textContent).toContain('Another app on this Mac has this session open.')
    expect(f.caution.cls.has('hidden')).toBe(false)
    t.type(f, 'Go ahead.'); t.submit(f); await flush()
    expect(turnPosts(t.calls)).toHaveLength(0)
    expect(f.verdict.innerHTML).toContain('data-gate="caution-send" data-cos="rr-gate" data-rr="' + esc(A_KEY) + '">Send anyway</button>')
    t.tap({ 'data-cos': 'rr-gate', 'data-rr': A_KEY, 'data-gate': 'caution-send' }); await flush()
    expect(turnPosts(t.calls)).toHaveLength(1)
    expect(turnPosts(t.calls)[0]!.body.prompt).toBe('Go ahead.')
  })
  it('one box at a time; each session keeps its own unsent words; Close keeps them and puts focus back on Answer', () => {
    const t = thread()
    t.paint([rr(), rr({ sid: SID2, excerpt: 'Other.' })])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.type(t.forms[0]!, 'For A.')
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': B_KEY })
    expect(t.html()).not.toContain('data-rr-answer-slot="' + esc(A_KEY) + '"')
    expect(t.html()).toContain('data-rr-answer-slot="' + esc(B_KEY) + '"')
    expect(t.forms[1]!.input.value).toBe('')
    t.tap({ 'data-cos': 'rr-answer-close', 'data-rr': B_KEY })
    expect(t.html()).not.toContain('data-rr-answer-slot')
    expect(t.document.activeElement).toBe(t.goBtn)
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    expect(t.forms[2]!.input.value).toBe('For A.')
  })
  it('the box is the SAME element across a repaint (his words and the gates\' state stay); no repaint while he types in it', () => {
    const t = thread()
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    const f = t.forms[0]!
    f.input.value = 'Half written'
    t.document.activeElement = f.send
    t.paint([rr(), rr({ excerpt: 'A newer reply.' })])
    expect(t.placed[A_KEY]).toBe(f)
    expect(f.input.value).toBe('Half written')
    expect(t.document.activeElement).toBe(f.send)
    // Typing: the feed is not drawn again under the finger.
    t.document.activeElement = f.input
    const before = t.paints()
    t.chat._paintFeed(false)
    expect(t.paints()).toBe(before)
  })
  it('the row going to an approval closes the box once he is not typing in it, and keeps his words', () => {
    const t = thread()
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.forms[0]!.input.value = 'Kept.'
    t.chat._state.sessionRows = [listRow({ id: SID, agentState: 'waiting', derived: { waiting_kind: 'plan' } })]
    t.chat._paintFeed(false)
    expect(t.chat._state.ans.key).toBe(A_KEY)
    t.document.activeElement = null
    t.paint([rr()])
    expect(t.chat._state.ans.key).toBe('')
    expect(t.chat._state.ansDraft[A_KEY]).toBe('Kept.')
  })
  it('a session that refuses: the server\'s words, Open the session in place of Fork, no fork anywhere', async () => {
    const routes: Routes = { ...OK, ['POST ' + P('/attach')]: { status: 409, body: { attached: false, reason: 'binding_refused_owner', reasonCopy: 'Another device holds this session.' } } }
    const t = thread({ routes })
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.type(t.forms[0]!, 'Hi.'); t.submit(t.forms[0]!); await flush()
    const v = t.forms[0]!.verdict.innerHTML
    expect(v).toContain('Another device holds this session.')
    expect(v).toContain('data-cos="rr-open" data-rr="' + esc(A_KEY) + '">Open the session</button>')
    expect(v + t.forms[0]!.innerHTML).not.toMatch(/fork/i)
  })
  it('COS never sees it: the box\'s code calls only the gates, never the chat\'s ask or post routes', () => {
    const box = CHAT.slice(CHAT.indexOf('  // ── the Answer box (7.0.53'), CHAT.indexOf('  function itemHtml(item) {'))
    expect(box.length).toBeGreaterThan(2000)
    expect(box).not.toMatch(/doAsk|postTurn|W\.api\(|fetch\(|\/api\//)
    expect(box).not.toMatch(/excerpt/)
  })
  it('styles are tokens only, with 16 px words so a phone never zooms', () => {
    const block = CSS.slice(CSS.indexOf('/* 7.0.53 the Answer box'))
    expect(block).toContain('.rr-input { width: 100%; min-height: 44px; max-height: 200px; padding: 11px 12px; font-size: 16px;')
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})

// ── Part 3: parity (ruling c) ───────────────────────────────────────────────────────────────────────────────────────
const GATE_COPY = (() => {
  const a = APP.indexOf('  var GATE_COPY = {'), b = APP.indexOf('\n  };', a)
  // eslint-disable-next-line no-new-func
  return new Function('return ' + APP.slice(a, b + 4).replace('  var GATE_COPY = ', '').replace(/;\s*$/, ''))() as Record<string, string>
})()
const READER = (() => {
  const g = APP.indexOf('  // ── the send gates, written once (7.0.53'), ge = APP.indexOf('  // Fork copies the session and runs the message there.', g)
  const withoutGates = APP.slice(0, g) + APP.slice(ge)
  const parts = ['  function sendSessionTurn(fork, opts) {', '  function renderVerdict(r) {', '  function watchTurn(bindingId, key, provider, id) {']
  return parts.map(p => { const a = withoutGates.indexOf(p); expect(a, p).toBeGreaterThan(0); return withoutGates.slice(a, withoutGates.indexOf('\n  }\n', a)) }).join('\n')
})()
// Where Today's sheet says the same words today (true) or its own (false), read from panes/today-actions.js at this head.
// A change in Today, the reader or the gates fails here until the follow-up after 7.0.53 moves both onto the gates.
const TODAY_SAME: Record<string, boolean> = {
  empty: true, uploading: true, fileFailed: true, lost: true, unreachable: true, cautionTitle: true, cautionBody: true, cautionSend: true, cautionCancel: true,
  retry: false, sendAnyway: false, cautionCodex: false, cautionOther: false, live: false, done: false, refused: true, ambiguous: true,
}
// Buttons are pinned as the button each side draws for that job (a bare word like Retry is used elsewhere too).
const BTN: Record<string, [string, string]> = {
  retry: ['data-sx="retry"', 'data-ta="retry"'], sendAnyway: ['data-action="send-anyway"', 'data-ta="send-anyway"'],
  cautionSend: ['data-sx="caution-send"', 'data-ta="caution-send"'], cautionCancel: ['data-sx="caution-cancel"', 'data-ta="caution-cancel"'],
}
const deEsc = (src: string) => src.replace(/\\u2019/g, '’')
const reEsc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function says(src: string, k: string, side: 0 | 1) {
  const v = GATE_COPY[k]!
  if (BTN[k]) return deEsc(src).includes(BTN[k]![side] + '>' + v + '</button>')
  return new RegExp("['>]" + reEsc(v) + "['<]").test(deEsc(src))
}
describe('parity: the gates speak the reader\'s words; Today\'s differences are recorded', () => {
  it('every gate word is the reader\'s own, word for word, in the job it does there', () => {
    expect(Object.keys(GATE_COPY).sort()).toEqual(Object.keys(TODAY_SAME).sort())
    for (const k of Object.keys(GATE_COPY)) {
      // The reader builds this one for Send or Fork; the gates' is its Send branch.
      if (k === 'uploading') { expect(READER).toContain("'A file is still uploading. ' + (fork ? 'Fork' : 'Send') + ' when it finishes.'"); expect(GATE_COPY[k]).toBe('A file is still uploading. Send when it finishes.'); continue }
      expect(says(READER, k, 0), k + ': ' + GATE_COPY[k]).toBe(true)
    }
  })
  it('Today\'s sheet: the same words where the table says so, its own words elsewhere', () => {
    for (const [k, same] of Object.entries(TODAY_SAME)) expect(says(TODAY, k, 1), `${k}: Today ${same ? 'has' : 'does not have'} "${GATE_COPY[k]}"`).toBe(same)
    // Today's own words for the differences (W1_partA_build.md, the 21:1x table).
    for (const w of ['data-ta="retry">Try again</button>', 'data-ta="send-anyway">Continue anyway</button>', "'Sent into the open session. It is working on it now.'", "'Done. The reply is below.'"]) expect(TODAY, w).toContain(w)
  })
  it('the order of the gates is the reader\'s: words, files, the caution, one at a time, then the send', () => {
    const send = APP.slice(APP.indexOf('  function gateSend(r, text, opts) {'), APP.indexOf('  function gateWatch('))
    const at = (s: string) => { const i = send.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    const order = [at('GATE_COPY.empty'), at('GATE_COPY.uploading'), at('GATE_COPY.fileFailed'), at('r.verdict.caution && !r.cautionAck'), at('if (r.sending) return'), at('continueSession(r, text, send)')]
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    const reader = APP.slice(APP.indexOf('  function sendSessionTurn(fork, opts) {'), APP.indexOf('  function continueSession('))
    const rat = (s: string) => { const i = reader.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    const rorder = [rat("'Write a message first.'"), rat("A file is still uploading."), rat("'A file did not upload. Retry it or remove it.'"), rat('r.verdict.caution && !r.cautionAck'), rat('if (r.sending) return;'), rat('continueSession(r, text, opts || {})')]
    expect([...rorder].sort((x, y) => x - y)).toEqual(rorder)
  })
  it('the two rulings that differ from the reader: the watch pauses while hidden; no turn-end answer and no "seen" (no automatic resend)', () => {
    const gates = APP.slice(APP.indexOf('  // ── the send gates, written once (7.0.53'), APP.indexOf('  // Fork copies the session and runs the message there.'))
    expect(gates).toContain('if (document.hidden) { started += GATE_WATCH_EVERY; return; }')
    expect(gates).not.toMatch(/turnEnd|seen:|sxPressSeen/)
    expect(READER).not.toContain('document.hidden')
  })
})

describe('7.0.53, the second piece: back from the phone, to the row he left', () => {
  const trip = (over: Record<string, unknown> = {}) => ({ v: 1, provider: 'claude', id: SID, key: 'ct-key-trip01', bindingId: 'b1', text: 'Ship it.', at: Date.now(), from: 'thread', item: 'ITEM', top: 140, ...over })
  it('a #/phone-return load from the thread: the address becomes #/messages/cos, the row goes back to its height, its box opens with his words under the same key, and the Mac is asked whether it landed', async () => {
    const item = rr()
    const routes: Routes = { ...OK, ['GET /api/agent-sessions/bindings/b1/turns/ct-key-trip01']: { status: 200, body: { outcome: 'completed' } } }
    const t = thread({ routes, hash: '#/phone-return', trip: trip({ item: item.id }) })
    expect(t.K.replaced).toEqual(['/control/#/messages/cos'])
    expect(t.chat._takePhoneReturn({ pane: 'messages', args: ['cos'] })).toBe(true)
    expect(t.chat._state.focusItem).toBe(item.id)
    expect(t.chat._state.focusTop).toMatchObject({ item: item.id, top: 140 })
    // Quiet, like Back: if the row is gone, the chat says nothing and opens nothing older.
    expect(t.chat._state.focusQuiet).toBe(true)
    // Once per load.
    expect(t.chat._takePhoneReturn({ pane: 'messages', args: ['cos'] })).toBe(false)
    t.paint([item])
    expect(t.chat._state.ans.key).toBe(A_KEY)
    expect(t.placed[A_KEY]).toBe(t.forms[0])
    expect(t.forms[0]!.input.value).toBe('Ship it.')
    expect(t.chat._state.ansS[A_KEY].draft).toMatchObject({ text: 'Ship it.', key: 'ct-key-trip01' })
    await flush()
    expect(t.calls.some(c => c.path === '/api/agent-sessions/bindings/b1/turns/ct-key-trip01')).toBe(true)
    // It landed: the words leave the box, the record is gone, and the box says so in the reader's words.
    expect(t.forms[0]!.input.value).toBe('')
    expect(t.forms[0]!.note.textContent).toBe('Sent from your phone.')
    expect(t.K.tabStore.size).toBe(0)
    // Never moved into the box by itself: no focus taken.
    expect(t.document.activeElement).toBe(null)
  })
  it('a record from the reader, an ordinary load, or another pane: the thread takes nothing', () => {
    expect(thread({ hash: '#/phone-return', trip: trip({ from: undefined, item: undefined, top: undefined }) }).chat._takePhoneReturn({ pane: 'messages', args: ['cos'] })).toBe(false)
    expect(thread({ hash: '', trip: trip() }).chat._takePhoneReturn({ pane: 'messages', args: ['cos'] })).toBe(false)
    expect(thread({ hash: '#/phone-return', trip: trip() }).chat._takePhoneReturn({ pane: 'messages', args: ['cos', 'fi_9'] })).toBe(false)
  })
  it('the row is gone by the time the chat is read: no box opens', () => {
    const t = thread({ hash: '#/phone-return', trip: trip({ item: 'fi_gone' }) })
    t.chat._takePhoneReturn({ pane: 'messages', args: ['cos'] })
    t.paint([rr({ sid: SID2 })])
    expect(t.chat._state.ans.key).toBe('')
    expect(t.forms).toHaveLength(0)
  })
  it('opening a box offers the phone key through the reader\'s own offer, with this box as its composer', () => {
    const t = thread()
    t.paint([rr()])
    const offers: any[] = []
    const real = t.K.kit.phoneOffer
    t.K.kit.phoneOffer = (r: unknown, o: any) => { offers.push([r, o]); return real(r, o) }
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    expect(offers).toHaveLength(1)
    expect(offers[0][0]).toBe(t.chat._state.ansS[A_KEY])
    expect(offers[0][1]).toMatchObject({ prefix: 'rr', from: 'thread' })
  })
  it('Send with the key from the box: the reader\'s own phone path, told it is the thread, with this row\'s newest item and height', async () => {
    const t = thread()
    const items = [rr({ at: new Date(Date.now() - 600000).toISOString() }), rr()]
    t.paint(items)
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    const seen: any[] = []
    t.K.kit.approvePhone = (o: any) => { seen.push(o); return Promise.resolve('opened') }
    t.tap({ 'data-cos': 'rr-phone' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ prefix: 'rr', from: 'thread' })
    expect(seen[0].r).toBe(t.chat._state.ansS[A_KEY])
    expect(seen[0].thread()).toMatchObject({ item: items[1]!.id })
    expect(seen[0].files()).toBe('none')
    expect(seen[0].live()).toBe(true)
    t.tap({ 'data-cos': 'rr-answer-close', 'data-rr': A_KEY })
    expect(seen[0].live()).toBe(false)
  })
  it('the caution asked on the way to the phone: its Send anyway continues on the phone, and Cancel sends nothing', async () => {
    const t = thread()
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    const r = t.chat._state.ansS[A_KEY]
    const seen: any[] = []
    t.K.kit.approvePhone = (o: any) => { seen.push(o); return Promise.resolve('opened') }
    t.chat._rrPhoneOpts(r).askCaution()
    expect(r.cautionVia).toBe('phone')
    expect(t.forms[0]!.verdict.innerHTML).toContain('Send into an open session?')
    t.tap({ 'data-cos': 'rr-gate', 'data-rr': A_KEY, 'data-gate': 'caution-send' })
    expect(seen).toHaveLength(1)
    expect(r.cautionAck).toBe(true)
    expect(turnPosts(t.calls)).toHaveLength(0)
    t.chat._rrPhoneOpts(r).askCaution()
    t.tap({ 'data-cos': 'rr-gate', 'data-rr': A_KEY, 'data-gate': 'caution-cancel' })
    expect(r.cautionVia).toBe(null)
    expect(seen).toHaveLength(1)
  })
})

describe('the lead 00:5x: X1\'s must-fix and the four smaller items', () => {
  const waiting = (kind: 'permission' | 'plan' | 'question') => ({ ...OK, ['GET ' + P('?turns=1')]: { status: 200, body: derivedFields('waiting', { waiting_kind: kind }) } })
  it('MUST-FIX: an approval that arrived while the box was open: Send reads the session fresh, refuses with the row\'s line, keeps his words, posts nothing', async () => {
    for (const kind of ['permission', 'plan'] as const) {
      const t = thread({ routes: waiting(kind) })
      t.paint([rr()])
      // The row was drawn idle: Answer is there.
      expect(t.html()).toContain('data-cos="rr-answer"')
      t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
      const f = t.forms[0]!
      t.type(f, 'Yes, go ahead.')
      t.submit(f); await flush()
      expect(t.calls.filter(c => c.method === 'GET' && c.path === P('?turns=1'))).toHaveLength(1)
      expect(turnPosts(t.calls)).toHaveLength(0)
      expect(t.calls.some(c => c.method === 'POST')).toBe(false)
      expect(f.note.textContent).toBe('It asked for approval. Approve it in Sessions, where the request card is.')
      expect(f.input.value).toBe('Yes, go ahead.')
      expect([f.send.disabled, f.input.readOnly]).toEqual([false, false])
    }
  })
  it('a session waiting on a question (not an approval) still takes the message', async () => {
    const t = thread({ routes: waiting('question') })
    t.paint([rr()]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.type(t.forms[0]!, 'Here is my answer.'); t.submit(t.forms[0]!); await flush()
    expect(turnPosts(t.calls)).toHaveLength(1)
  })
  it('no answer to the fresh read: nothing posted, his words kept, and the box says so', async () => {
    for (const r of [{ status: 500, body: {} }, new TypeError('Load failed')]) {
      const t = thread({ routes: { ...OK, ['GET ' + P('?turns=1')]: () => r as Reply } })
      t.paint([rr()]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
      t.type(t.forms[0]!, 'Go.'); t.submit(t.forms[0]!); await flush()
      expect(t.calls.some(c => c.method === 'POST')).toBe(false)
      expect(t.forms[0]!.note.textContent).toBe('COS could not check whether this session is waiting on an approval. Your words are still here; send again in a moment.')
      expect(t.forms[0]!.input.value).toBe('Go.')
    }
  })
  it('the key\'s Send gets the same fresh check: no while an approval waits (with the line), yes when idle', async () => {
    const t = thread({ routes: waiting('permission') })
    t.paint([rr()]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    const r = t.chat._state.ansS[A_KEY]
    expect(await t.chat._rrPhoneOpts(r).precheck()).toBe(false)
    expect(t.forms[0]!.note.textContent).toBe('It asked for approval. Approve it in Sessions, where the request card is.')
    const u = thread()
    u.paint([rr()]); u.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    expect(await u.chat._rrPhoneOpts(u.chat._state.ansS[A_KEY]).precheck()).toBe(true)
  })
  it('a second Send while the fresh read is out posts nothing more', async () => {
    const t = thread()
    t.paint([rr()]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.type(t.forms[0]!, 'Once.')
    t.submit(t.forms[0]!); t.submit(t.forms[0]!); await flush()
    expect(t.calls.filter(c => c.path === P('?turns=1'))).toHaveLength(1)
    expect(turnPosts(t.calls)).toHaveLength(1)
  })
  it('(a) the "To" line isolates the session-written name, so a right-to-left override cannot reorder the provider and short id', () => {
    const t = thread()
    const item = rr(); (item.links[0] as any).label = 'Ship ‮di trohs ,edualC'
    t.paint([item]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    expect(t.forms[0]!.innerHTML).toMatch(/To <strong><bdi>Ship ‮di trohs ,edualC<\/bdi><\/strong>, Claude, <span class="rr-id">0a1b2c3d<\/span>/)
  })
  it('(b) the box takes focus without scrolling, and opening it while following the newest line does not scroll to the end', () => {
    const t = thread()
    t.paint([rr()])           // a stick paint: following the newest line
    const before = t.scrolls.length
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    expect(t.forms[0]!.input.focusOpts).toEqual({ preventScroll: true })
    expect(t.scrolls.slice(before)).toEqual([])
    // A later quiet repaint does not either: he is answering this row now, not following.
    t.document.activeElement = null
    t.chat._paintFeed(false)
    expect(t.scrolls.slice(before)).toEqual([])
    // Close does not either.
    t.tap({ 'data-cos': 'rr-answer-close', 'data-rr': A_KEY })
    expect(t.scrolls.slice(before)).toEqual([])
  })
  it('(c) a second tap on the same Answer keeps the open box and his words (no new box)', () => {
    const t = thread()
    t.paint([rr()]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.forms[0]!.input.value = 'Half way.'
    t.document.activeElement = null
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    expect(t.forms).toHaveLength(1)
    expect(t.placed[A_KEY]).toBe(t.forms[0])
    expect(t.forms[0]!.input.value).toBe('Half way.')
    expect(t.document.activeElement).toBe(t.forms[0]!.input)
  })
  it('(d) Close stops the watch at once: no read of the turn after it', async () => {
    const t = thread()
    t.paint([rr()]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.type(t.forms[0]!, 'Go.'); t.submit(t.forms[0]!); await flush()
    expect(turnPosts(t.calls)).toHaveLength(1)
    t.tap({ 'data-cos': 'rr-answer-close', 'data-rr': A_KEY })
    const n = t.calls.length
    t.K.tick(); t.K.tick(); await flush()
    expect(t.calls.length).toBe(n)
    expect(t.chat._state.ansS[A_KEY].watchTimer).toBe(null)
  })
})

describe('the two survivors of the 00:5x mutants (Q1 asks for each to have its test)', () => {
  it('M11: closing a box that sits above what he reads holds the first card he can see (the page scrolls back by what the box took)', () => {
    const t = thread({ card: { id: 'fi_seen', top: 40, shift: -120 } })
    t.paint([rr()])
    t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.document.activeElement = null
    const before = t.scrolls.length
    t.tap({ 'data-cos': 'rr-answer-close', 'data-rr': A_KEY })
    expect(t.scrolls.slice(before)).toEqual([['by', 0, -120]])
  })
  it('M14: when the box goes because its row went (not Close), the watch stops at its next tick', async () => {
    const t = thread()
    t.paint([rr()]); t.tap({ 'data-cos': 'rr-answer', 'data-rr': A_KEY })
    t.type(t.forms[0]!, 'Go.'); t.submit(t.forms[0]!); await flush()
    expect(turnPosts(t.calls)).toHaveLength(1)
    t.document.activeElement = null
    t.paint([rr({ sid: SID2 })])
    expect(t.chat._state.ans.key).toBe('')
    const n = t.calls.length
    t.K.tick(); await flush()
    expect(t.calls.length).toBe(n)
  })
})

describe('X1 01:0x: the list row\'s real shape, and no approval from the thread', () => {
  it('a row as the server sends it (state running, agent_state waiting on a permission) hides Answer and shows the line; the old wrong field does nothing', () => {
    const t = thread()
    t.chat._state.sessionRows = [listRow({ id: SID, agentState: 'waiting', derived: { waiting_kind: 'permission' } })]
    const real = t.paint([rr()])
    expect(real).not.toContain('data-cos="rr-answer"')
    expect(real).toContain('It asked for approval.')
    // `state` is running or recent on a real row; a fixture that put "waiting" there is a field the server never sends.
    t.chat._state.sessionRows = [{ ...listRow({ id: SID, agentState: 'running' }), state: 'waiting', waiting_kind: 'permission' }]
    const wrong = t.paint([rr()])
    expect(wrong).toContain('data-cos="rr-answer"')
    expect(wrong).not.toContain('It asked for approval.')
  })
})
