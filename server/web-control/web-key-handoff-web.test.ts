// 6.99.31 Phase 3: the Control Web composer's "Approve on this phone" (the REAL block sliced out of app.js
// between its BEGIN and END markers), with fakes for the page helpers it calls. Flag off (no webKeySigner
// capability): no request, no button, and the composer markup is the 6.99.29 markup, pinned verbatim.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CHAT = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const BEGIN = APP.indexOf('// ── BEGIN web-key handoff')
const END = APP.indexOf('// ── END web-key handoff ──')
const BLOCK = APP.slice(BEGIN, END)
const API_BEGIN = APP.indexOf('  function apiAnswer(path, opts)')
const API_BLOCK = APP.slice(API_BEGIN, APP.indexOf('\n\n  // Per-browser memory', API_BEGIN))
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }
const HOST = 'ukaoma-mac-studio.tail38457f.ts.net'

class El {
  children: El[] = []; attrs: Record<string, string> = {}; textContent = ''; title = ''; className = ''; type = ''; value = ''; innerHTML = ''; disabled = false; clientWidth = 0
  parentNode: El | null = null
  listeners: Record<string, (e?: any) => void> = {}
  get firstChild() { return this.children[0] ?? null }
  get nextSibling(): El | null { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] ?? null }
  get classList() { const el = this; const list = () => el.className.split(/\s+/).filter(Boolean)
    return { contains: (c: string) => list().includes(c), add: (c: string) => { if (!list().includes(c)) el.className = [...list(), c].join(' ') },
      remove: (c: string) => { el.className = list().filter(x => x !== c).join(' ') }, toggle: (c: string, on?: boolean) => { const has = list().includes(c); const want = on === undefined ? !has : on; if (want && !has) el.className = [...list(), c].join(' '); if (!want && has) el.className = list().filter(x => x !== c).join(' '); return want } } }
  appendChild(n: El) { if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = this; this.children.push(n) }
  addEventListener(k: string, fn: (e?: any) => void) { this.listeners[k] = fn }
  constructor(readonly tag: string, public id = '') {}
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  removeAttribute(k: string) { delete this.attrs[k] }
  querySelector(sel: string): El | null {
    const m = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(sel)
    const walk = (e: El): El | null => { for (const c of e.children) { if (m && (m[2] === undefined ? m[1] in c.attrs : c.attrs[m[1]] === m[2])) return c; const d = walk(c); if (d) return d } return null }
    return walk(this)
  }
  insertBefore(n: El, ref: El | null) {
    if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1)
    n.parentNode = this
    if (ref === null) { this.children.push(n); return }
    this.children.splice(Math.max(0, this.children.indexOf(ref)), 0, n)
  }
  removeChild(n: El) { const i = this.children.indexOf(n); if (i < 0) throw new Error('not a child'); this.children.splice(i, 1); n.parentNode = null }
}

function harness(opts: { signer: number; activeKeys?: number; files?: string; handoff?: (body: any) => { status: number; body: any } | Promise<{ status: number; body: any }>; text?: string; bound?: boolean; packets?: any[]; prefix?: 'session' | 'ta' | 'rr'; packetRead?: Promise<any>; statusRead?: () => Promise<any>; hostname?: string; navigate?: (url: string) => void; statusWire?: (path: string, init: any) => Promise<any>; standalone?: boolean; readerWidth?: number; hash?: string; trip?: Record<string, unknown> | string; storageThrows?: boolean; turnStatus?: (path: string) => { status: number; body: any } | Promise<{ status: number; body: any }> }) {
  const prefix = opts.prefix ?? 'session'
  const form = new El('form', prefix + '-form'), actions = new El('div'), send = new El('button', prefix + '-send'), input = new El('textarea', prefix + '-input')
  form.children.push(input, actions); input.parentNode = form; actions.parentNode = form; actions.children.push(send); send.parentNode = actions
  input.attrs.placeholder = 'Continue this session…'; send.textContent = 'Send'
  const chat = new El('div', 'chat'); chat.appendChild(form)
  input.value = opts.text ?? 'Yes, go ahead.  '
  const ids: Record<string, El> = { [prefix + '-form']: form, [prefix + '-send']: send, [prefix + '-input']: input }
  const reader = new El('div', 'session-reader'), body = new El('div', 'session-body')
  if (opts.readerWidth !== undefined) { reader.clientWidth = opts.readerWidth; ids['session-reader'] = reader; ids['session-body'] = body }
  const requests: Array<{ path: string; body?: any }> = []
  const assigned: string[] = []
  const statuses: Array<[string, string | undefined]> = []
  const statusTimeouts: number[] = [], timeoutDelays: number[] = [], downMarks: boolean[] = []
  const timers = new Map<number, () => void>()
  let timerId = 0, turnCounter = 0
  let now = Date.now()
  class Clock extends Date { static now() { return now } }
  const windowListeners: Record<string, Array<(ev: { persisted: boolean }) => void>> = {}
  const window = { addEventListener: (name: string, fn: (ev: { persisted: boolean }) => void) => { (windowListeners[name] ??= []).push(fn) },
    removeEventListener: (name: string, fn: any) => { windowListeners[name] = (windowListeners[name] ?? []).filter(f => f !== fn) },
    matchMedia: (q: string) => ({ matches: q === '(display-mode: standalone)' && !!opts.standalone }) }
  // 7.0.51 item 6: the trip timer, visibility and the numbers-only breadcrumb.
  const tripTimers: Array<{ fn: () => void; ms: number; done: boolean }> = []
  const docListeners: Record<string, Array<() => void>> = {}
  const doc = { createElement: (t: string) => new El(t), visibilityState: 'visible',
    addEventListener: (name: string, fn: () => void) => { (docListeners[name] ??= []).push(fn) },
    removeEventListener: (name: string, fn: () => void) => { docListeners[name] = (docListeners[name] ?? []).filter(f => f !== fn) } }
  const crumbs: Array<[string, Record<string, unknown>]> = []
  // 7.0.51 item 4: per-tab storage and the address (hash, replace).
  const store = new Map<string, string>()
  if (opts.trip !== undefined) store.set('cos.phoneTrip', typeof opts.trip === 'string' ? opts.trip : JSON.stringify(opts.trip))
  const boom = () => { if (opts.storageThrows) throw new Error('SecurityError') }
  const sessionStorage = { getItem: (k: string) => { boom(); return store.has(k) ? store.get(k)! : null }, setItem: (k: string, v: string) => { boom(); store.set(k, String(v)) }, removeItem: (k: string) => { boom(); store.delete(k) } }
  const replaced: string[] = []
  const actualStatus = opts.statusWire ? new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'sxNoteClock', 'noteServer', 'showAuth', 'unreachableError', 'Date', API_BLOCK + '\nreturn apiAnswer;')(
    opts.statusWire, AbortController, (fn: () => void, delay: number) => { timeoutDelays.push(delay); timers.set(++timerId, fn); return timerId }, (id: number) => timers.delete(id),
    () => {}, (up: boolean) => downMarks.push(up), () => {}, (err: unknown) => err, Clock,
  ) : null
  const r: any = { provider: 'claude', id: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d', sending: false, draft: null as any }
  const state = { reading: r }
  const apiAnswer = (path: string, o: any = {}) => {
    requests.push({ path, body: o.body })
    if (path === '/api/web-key/status') { statusTimeouts.push(o.timeoutMs); return actualStatus ? actualStatus(path, o) : opts.statusRead ? opts.statusRead() : Promise.resolve({ status: 200, body: { ok: true, activeKeys: opts.activeKeys ?? 1 } }) }
    if (path.startsWith('/api/web-key/packets?')) return opts.packetRead ?? Promise.resolve({ status: 200, body: { ok: true, packets: opts.packets ?? [] } })
    if (path.endsWith('/attach')) return Promise.resolve({ status: 201, body: { attached: true, bindingId: 'b-1', epoch: 2 } })
    if (/^\/api\/agent-sessions\/bindings\/[^/]+\/turns\/[^/]+$/.test(path)) return Promise.resolve(opts.turnStatus ? opts.turnStatus(path) : { status: 404, body: { outcome: 'unknown' } })
    if (path === '/api/web-key/handoff') return Promise.resolve(opts.handoff ? opts.handoff(o.body) : { status: 201, body: { ok: true, handoffId: 'h'.repeat(24), signerUrl: `https://${HOST}:3144/#h=${'h'.repeat(24)}` } })
    return Promise.resolve({ status: 404, body: {} })
  }
  const nextKey = () => 'ct-key-' + String(++turnCounter).padStart(6, '0')
  // app.js clearBoxOf: only the very words that were sent leave the box.
  const clearBoxOf = (text: string, rr: any) => { if (rr === state.reading && input.value.trim() === String(text).trim()) input.value = ''; if (state.reading && state.reading.draft && state.reading.draft.text === text) state.reading.draft = null }
  const fns = new Function(
    'readerKit', 'apiAnswer', 'state', '$', 'document', 'sessionStatus', 'readerFilesOn', 'readerBox', 'readerFilesState', 'draftFor', 'bindingFor', 'rememberBinding', 'sessionPath', 'cosSessionId', 'targetKey', 'location', 'URL', 'newTurnKey', 'window', 'Date', 'clearBoxOf', 'setTimeout', 'layoutCrumb', 'navigator', 'sessionStorage', 'history', 'turnEndOf', 'readerRowOf',
    BLOCK + '\nreturn { paintWebKeyOffer: paintWebKeyOffer, approveOnPhone: approveOnPhone, webKeySignerUrlOk: webKeySignerUrlOk, phoneBusyPaint: phoneBusyPaint, phoneBoxPlaceholder: phoneBoxPlaceholder, CHANNEL: PHONE_CHANNEL_EFFECT, draftForPlain: function (t, rr) { return draftFor(t, rr).key; } };',
  )(
    () => ({ webKeySigner: () => opts.signer }), apiAnswer, state, (id: string) => ids[id] ?? null, doc,
    (t: string, k?: string) => statuses.push([t, k]), () => true, () => ({}), () => opts.files ?? 'none',
    (text: string, rr: any, ids?: string[]) => { const f = Array.isArray(ids) ? ids.slice() : []; rr.draft = rr.draft && rr.draft.text === text && (rr.draft.ids || []).join(',') === f.join(',') ? rr.draft : { text, key: nextKey(), ids: f }; return rr.draft },
    () => (opts.bound === false ? null : { bindingId: 'b-1', epoch: 2 }), () => {}, (p: string, i: string, t: string) => `/api/agent-sessions/${p}/${i}${t}`, () => 'cos-1',
    (p: string, i: string) => `${p.length}:${p}:${i.length}:${i}`, { hostname: opts.hostname ?? HOST, hash: opts.hash ?? '', pathname: '/control/', search: '', assign: (u: string) => { if (opts.navigate) opts.navigate(u); assigned.push(u) }, replace: (u: string) => { replaced.push(u) } }, URL, nextKey, window, Clock, clearBoxOf,
    (fn: () => void, ms: number) => { tripTimers.push({ fn, ms, done: false }); return tripTimers.length }, (what: string, data: Record<string, unknown>) => { crumbs.push([what, data]); return true }, { standalone: !!opts.standalone }, sessionStorage, { state: { keep: 1 }, replaceState: (st: unknown, _t: string, u: string) => { expect(st).toEqual({ keep: 1 }); replaced.push(u) } },
    (row: any) => (row && row.ask ? row.ask : null), (rr: any) => (rr && rr.row ? rr.row : null),
  ) as { paintWebKeyOffer: (r: unknown, o?: unknown) => void; approveOnPhone: (o?: unknown) => Promise<string>; webKeySignerUrlOk: (u: string) => boolean; draftForPlain: (t: string, r: unknown) => string; phoneBusyPaint: (r: unknown) => void; phoneBoxPlaceholder: () => string; CHANNEL: Record<string, string> }
  const liveView = { active: true }
  const viewOpts = { r, prefix, live: () => liveView.active, status: (t: string, k?: string) => statuses.push([t, k]), files: () => opts.files ?? 'none' }
  const plainKey = () => fns.draftForPlain(input.value.trim(), r)
  return { ...fns, r, state, form, input, chat, send, reader, body, plainKey, requests, assigned, statuses, liveView, viewOpts, replaceForm: () => { ids[prefix + '-form'] = new El('form', prefix + '-form') },
    pageShow: (persisted = true) => { for (const fn of windowListeners.pageshow ?? []) fn({ persisted }) }, advance: (ms: number) => { now += ms },
    pageHide: () => { for (const fn of [...(windowListeners.pagehide ?? [])]) fn({ persisted: true }) },
    tripTimers, crumbs, store, replaced, runTripTimers: () => { for (const t of tripTimers) if (!t.done) { t.done = true; t.fn() } }, runTripTimer: (i: number) => { const t = tripTimers[i]; if (t && !t.done) { t.done = true; t.fn() } },
    setVisible: (v: 'visible' | 'hidden') => { doc.visibilityState = v; for (const fn of [...(docListeners.visibilitychange ?? [])]) fn() },
    docListenerCount: () => Object.values(docListeners).reduce((n, a) => n + a.length, 0), windowListenerCount: (name: string) => (windowListeners[name] ?? []).length,
    statusTimeouts, timeoutDelays, downMarks, timerCount: () => timers.size, expireTimers: () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn() },
    addView: (other: 'session' | 'ta') => {
      const another = new El('form', other + '-form'), buttons = new El('div'), submit = new El('button', other + '-send'), text = new El('textarea', other + '-input')
      another.appendChild(buttons); buttons.appendChild(submit)
      ids[other + '-form'] = another; ids[other + '-send'] = submit; ids[other + '-input'] = text
      return { form: another, opts: { ...viewOpts, prefix: other } }
    } }
}

describe('flag off: the composer is exactly as before', () => {
  it('no webKeySigner capability: no request and no button', async () => {
    const h = harness({ signer: 0 })
    h.paintWebKeyOffer(h.r)
    await flush()
    expect(h.requests).toEqual([])
    expect(h.form.querySelector('[data-action="approve-on-phone"]')).toBeNull()
    expect(h.form.querySelector('[data-phone-setup]')).toBeNull()
  })
  // 7.0.56: 6.99.29's composer plus the dock's parts (the small Fork's class, the full-only extras and the Stop row);
  // the flag still adds nothing to it.
  it('the composer markup is 7.0.56\'s (6.99.29\'s plus the dock), byte for byte', () => {
    const PINNED = `'<form class="composer att-composer" id="session-form" data-provider="' + esc(provider) + '" data-id="' + esc(id) + '">' +
            '<div class="cc-chips att-files hidden" id="session-files"></div>' +
            '<textarea id="session-input" rows="1" placeholder="Continue this session…" enterkeyhint="send" aria-label="Continue this session"></textarea>' +
            '<div class="composer-actions"><span id="session-clip" class="att-clip"></span><button type="button" class="btn small sx-fork-small" data-action="fork-session" title="Copy this session and send the message to the copy">Fork</button>' +
            '<button type="submit" class="btn primary small" id="session-send">Send</button></div>' +
            // 7.0.56: full only (.sx-docked): one Fork (the same fork-session), Copy session with its note, and Stop.
            '<div class="sx-x2"><button type="button" class="cx-btn quiet" data-action="fork-session" title="Runs your message in a copy of this thread. The original is untouched.">Fork with this message</button>' +
              '<button type="button" class="cx-btn quiet" data-sx="copy-session" title="A kickstart brief for another agent, built from the turns COS serves. Not a Claude Code resume: it does not reopen this session.">Copy session</button></div>' +
            '<p class="sx-x2-note">Kickstart brief for another agent. Not a Claude Code resume.</p>' +
            '<div class="sx-stop-row" id="session-stop-row"></div>' +
          '</form>`
    expect(APP.split(PINNED).length - 1).toBe(1)
    // The only button the composer markup can ever carry for phone approval is added by paintWebKeyOffer.
    expect(APP.split('approve-on-phone').length - 1).toBe(2)
  })
  it('health without webKeySigner reads as 0 in the chat caps (cos-chat.js)', () => {
    expect(CHAT).toContain("webKeySigner: h && h.webKeySigner === 1 ? 1 : 0")
    expect(CHAT).toContain('webKeySigner: function () { return C.caps && C.caps.webKeySigner === 1 ? 1 : 0; }')
  })
})

describe('flag on with an enrolled phone key', () => {
  // 7.0.56 (Miles 18:3x "Yes, same everywhere"; was 7.0.51's verified primary beside the words): with no request card
  // up, the plain Send is the filled primary beside the words and Send with passkey sits, once, where Send was.
  it('puts the plain Send beside the words and Send with passkey, once, in the quiet row', async () => {
    const h = harness({ signer: 1 })
    h.paintWebKeyOffer(h.r)
    h.paintWebKeyOffer(h.r)
    await flush()
    const b = h.form.querySelector('[data-action="approve-on-phone"]')
    expect(b?.className).toBe('pa-go')
    expect(h.form.children.map(c => c.attrs['data-action'] ?? c.id ?? c.tag)).toEqual(['session-input', 'session-send', ''])
    expect(b?.parentNode?.children.map(c => c.attrs['data-action'] ?? c.id)).toEqual(['approve-on-phone'])
    expect(h.send.textContent).toBe('Send')
    expect(h.form.classList.contains('pa-req')).toBe(false)
    expect(h.form.classList.contains('pa-on')).toBe(true)
    expect(h.requests.filter(q => q.path === '/api/web-key/status')).toHaveLength(1)
  })
  it('no enrolled key: setup link instead of an approval button', async () => {
    const h = harness({ signer: 1, activeKeys: 0 })
    h.paintWebKeyOffer(h.r)
    await flush()
    expect(h.form.querySelector('[data-action="approve-on-phone"]')).toBeNull()
    expect(h.form.querySelector('[data-phone-setup]')?.textContent).toBe('Set up phone approvals')
  })
  it('the tap posts the handoff (words in the body, never the URL) and navigates top level to the signer', async () => {
    const h = harness({ signer: 1 })
    expect(await h.approveOnPhone()).toBe('opened')
    const post = h.requests.find(q => q.path === '/api/web-key/handoff')!
    expect(post.body).toEqual({ bindingId: 'b-1', epoch: 2, targetKey: '6:claude:36:a4b2b4dd-e40c-4b08-8a11-c89a018c197d', clientTurnId: 'ct-key-000001', prompt: 'Yes, go ahead.' })
    expect(h.assigned).toEqual([`https://${HOST}:3144/#h=${'h'.repeat(24)}`])
    expect(h.assigned[0]).not.toContain('go ahead')
  })
  it('never navigates to anything but the signer on this host, port 3144, path /, fragment id only', async () => {
    const h = harness({ signer: 1 })
    for (const u of [`https://evil.example:3144/#h=${'h'.repeat(24)}`, `http://${HOST}:3144/#h=${'h'.repeat(24)}`, `https://${HOST}:3143/#h=${'h'.repeat(24)}`,
      `https://${HOST}:3144/x#h=${'h'.repeat(24)}`, `https://${HOST}:3144/?w=yes#h=${'h'.repeat(24)}`, `https://${HOST}:3144/#h=short`, 'javascript:alert(1)']) {
      expect(h.webKeySignerUrlOk(u), u).toBe(false)
    }
    const bad = harness({ signer: 1, handoff: () => ({ status: 201, body: { ok: true, signerUrl: 'https://evil.example:3144/#h=' + 'h'.repeat(24) } }) })
    expect(await bad.approveOnPhone()).toBe('refused')
    expect(bad.assigned).toEqual([])
  })
  it('a late handoff response never navigates after the active session changes', async () => {
    let finish!: (value: { status: number; body: any }) => void
    const h = harness({ signer: 1, handoff: () => new Promise(resolve => { finish = resolve }) })
    const pending = h.approveOnPhone(); await flush()
    h.state.reading = { provider: 'codex', id: 'other' } as any
    finish({ status: 201, body: { ok: true, signerUrl: `https://${HOST}:3144/#h=${'h'.repeat(24)}` } })
    expect(await pending).toBe('stale')
    expect(h.assigned).toEqual([])
    expect(h.r.sending).toBe(false)
  })
  it('files in the box: refused before any request', async () => {
    const h = harness({ signer: 1, files: 'ready' })
    expect(await h.approveOnPhone()).toBe('files')
    expect(h.requests).toEqual([])
  })
  it('a refusal shows the plain reason and leaves the page where it is', async () => {
    const h = harness({ signer: 1, handoff: () => ({ status: 409, body: { ok: false, error: 'no_phone_key' } }) })
    expect(await h.approveOnPhone()).toBe('refused')
    expect(h.assigned).toEqual([])
    expect(h.statuses.at(-1)).toEqual(['No phone has a key yet. Set one up on the approval page first.', 'error'])
    expect(h.r.sending).toBe(false)
  })
})

describe('first phone setup, using the real Sessions and Today offer block', () => {
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: a zero-key read offers one top-level bare same-host signer link with no handoff or packet read`, async () => {
      const h = harness({ signer: 1, activeKeys: 0, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts)
      h.paintWebKeyOffer(h.r, h.viewOpts)
      await flush()
      const link = h.form.querySelector('[data-phone-setup]')!
      expect(link).not.toBeNull()
      expect(link.tag).toBe('a')
      expect(link.attrs).toMatchObject({ href: `https://${HOST}:3144/`, target: '_top' })
      expect(h.form.children[1].children.map(c => c.attrs['data-phone-setup'] ?? c.id)).toEqual(['1', prefix + '-send'])
      expect(h.form.classList.contains('pa-on')).toBe(false)
      expect(h.form.querySelector('[data-action="approve-on-phone"]')).toBeNull()
      expect(h.form.querySelector('[data-ta="approve-phone"]')).toBeNull()
      expect(h.requests).toEqual([{ path: '/api/web-key/status', body: undefined }])
      expect(h.assigned).toEqual([])
    })
    it(`${prefix}: capability off never reads status or offers setup`, async () => {
      const h = harness({ signer: 0, activeKeys: 0, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.requests).toEqual([])
      expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
    })
    it(`${prefix}: an enrolled key offers approval and no setup link`, async () => {
      const h = harness({ signer: 1, activeKeys: 1, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
      expect(h.form.querySelector('[data-phone-setup]')).toBeNull()
      expect(h.requests.some(q => q.path.startsWith('/api/web-key/packets?'))).toBe(true)
    })
    for (const stateChange of ['closed', 'replaced-form'] as const) {
      it(`${prefix}: a late zero-key status cannot paint into a ${stateChange} view`, async () => {
        let finish!: (value: any) => void
        const h = harness({ signer: 1, prefix, statusRead: () => new Promise(resolve => { finish = resolve }) })
        h.paintWebKeyOffer(h.r, h.viewOpts)
        if (stateChange === 'closed') h.liveView.active = false
        else h.replaceForm()
        finish({ status: 200, body: { ok: true, activeKeys: 0 } }); await flush()
        expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
        expect(h.requests).toHaveLength(1)
        expect(h.assigned).toEqual([])
      })
    }
  }
  for (const response of [
    { status: 503, body: { ok: false } }, { status: 401, body: { ok: false } },
    { status: 200, body: { ok: true } }, { status: 200, body: { ok: true, activeKeys: '0' } },
    { status: 200, body: { ok: true, activeKeys: -1 } }, { status: 200, body: { ok: true, activeKeys: 0.5 } },
  ]) {
    it(`unknown status ${JSON.stringify(response)} does not claim no key and can retry`, async () => {
      let reads = 0
      const h = harness({ signer: 1, statusRead: async () => ++reads === 1 ? response : { status: 200, body: { ok: true, activeKeys: 0 } } })
      h.paintWebKeyOffer(h.r); await flush()
      expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
      h.paintWebKeyOffer(h.r); await flush()
      expect(h.form.querySelector('[data-phone-setup]')).not.toBeNull()
      expect(h.requests).toHaveLength(2)
    })
  }
  it('a rejected status request offers neither setup nor approval and can retry', async () => {
    let reads = 0
    const h = harness({ signer: 1, statusRead: () => ++reads === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ status: 200, body: { ok: true, activeKeys: 0 } }) })
    h.paintWebKeyOffer(h.r); await flush()
    expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
    h.paintWebKeyOffer(h.r); await flush()
    expect(h.form.querySelector('[data-phone-setup]')).not.toBeNull()
    expect(h.requests).toHaveLength(2)
  })
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'ts.net', 'tail38457f.ts.net', 'evil.example', 'user@' + HOST, HOST + ':3144', '-bad.tail38457f.ts.net', 'bad..tail38457f.ts.net']) {
    it(`does not offer setup on unsupported host ${hostname}`, async () => {
      const h = harness({ signer: 1, activeKeys: 0, hostname })
      h.paintWebKeyOffer(h.r); await flush()
      expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
      // 7.0.51 (W1, lead 06:5x): the host is decided before anything is asked, so no status read either.
      expect(h.requests).toHaveLength(0)
      expect(h.assigned).toEqual([])
    })
  }
})

describe('7.0.51: the host is decided before the phone action is painted or used (W1, lead 06:5x)', () => {
  const HOSTS = ['localhost', '127.0.0.1', '192.168.1.20', '[::1]', 'ts.net', 'tail38457f.ts.net', 'mac.local', 'evil.example', '-bad.tail38457f.ts.net']
  for (const prefix of ['session', 'ta'] as const) {
    for (const hostname of HOSTS) {
      it(`${prefix}: on ${hostname} with a key enrolled, no approval button and no request at all`, async () => {
        const h = harness({ signer: 1, activeKeys: 1, hostname, prefix })
        h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
        expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
        expect(h.requests).toEqual([])
      })
      it(`${prefix}: on ${hostname}, a tap that reaches approveOnPhone opens nothing and says why`, async () => {
        const h = harness({ signer: 1, activeKeys: 1, hostname, prefix })
        expect(await h.approveOnPhone(h.viewOpts)).toBe('host')
        expect(h.requests).toEqual([])
        expect(h.assigned).toEqual([])
        expect(h.r.sending).toBe(false)
        expect(h.statuses.at(-1)).toEqual(['Approval on the phone works only when Control is open at your Mac’s Tailscale name. Send still works here.', 'error'])
      })
    }
    it(`${prefix}: on the Mac's ts.net name the button and the handoff work as before`, async () => {
      const h = harness({ signer: 1, activeKeys: 1, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
    })
  }
})

const PACKET = { v: 'cos-web-packet/1', packetId: 'AAECAwQFBgcICQoL', action: 'publish', artifact: '@gotcos/glasses-server', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel: 'npm-latest', provider: 'claude', sessionId: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d', createdAt: Date.now(), exp: Date.now() + 1800000 }
describe('the request card (7.0.51; was the explicit packet selection)', () => {
  const card = (h: any) => [...h.chat.children].find((c: any) => c.attrs['data-phone-card'] === '1')
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: shows only this receiving session's newest request, in full, and Approve carries exactly its hash`, async () => {
      const sha = 'b'.repeat(64), older = { ...PACKET, version: '7.0.5', createdAt: PACKET.createdAt - 60000 }
      const h = harness({ signer: 1, prefix, text: '', packets: [{ packet: older, packetSha256: 'e'.repeat(64) }, { packet: PACKET, packetSha256: sha }, { packet: { ...PACKET, sessionId: 'other' }, packetSha256: 'c'.repeat(64) }] })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      const c = card(h)
      expect(c).toBeDefined()
      expect(h.chat.children.indexOf(c)).toBe(h.chat.children.indexOf(h.form) - 1)
      const text = (e: any): string => e.textContent + e.children.map(text).join('')
      const [l1, does, facts, more] = c.children
      expect(text(l1.children[0])).toBe('Publish' + PACKET.artifact + PACKET.version)
      expect(l1.children[1].className).toBe('pa-exp-r')
      expect(l1.children[1].textContent).toMatch(/^expires \d/)
      expect(does.children.map((e: any) => [e.className, e.textContent])).toEqual([['pa-does-t', h.CHANNEL['npm-latest']], ['pa-ch-in', ' · npm-latest']])
      expect(facts.children.map((e: any) => e.className)).toEqual(['pa-ch', 'pa-phone', 'pa-wide'])
      expect(facts.children[1].textContent).toMatch(/^, expires \d/)
      expect(facts.children[2].textContent).toMatch(/^ · asked by this Claude session · expires \d/)
      expect(more.textContent).toBe('1 of 2 requests, newest shown.')
      const go = h.form.querySelector('[data-phone-offer]')!
      expect(go.innerHTML).toContain('<span class="pa-short">Approve</span><span class="pa-long">Approve and send</span>')
      expect(go.getAttribute('aria-label')).toBe('Approve the request and send, confirmed with this phone')
      expect(h.input.getAttribute('placeholder')).toBe('Add a note')
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const post = h.requests.find(q => q.path === '/api/web-key/handoff')!.body
      expect(post).toMatchObject({ packetSha256: sha, bindingId: 'b-1', targetKey: '6:claude:36:' + PACKET.sessionId })
      // An empty box sends the standard words, which the approval page shows exactly before he signs.
      expect(post.prompt).toBe('Approve publish @gotcos/glasses-server 7.0.6 on npm-latest.')
    })
    it(`${prefix}: words he types go as his own note, with the same request`, async () => {
      const sha = 'b'.repeat(64), h = harness({ signer: 1, prefix, text: 'Ship it after the 7:00 check.', packets: [{ packet: PACKET, packetSha256: sha }] })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body).toMatchObject({ prompt: 'Ship it after the 7:00 check.', packetSha256: sha })
    })
    it(`${prefix}: with no request waiting, the verified Send carries no packet and stays message scope`, async () => {
      const h = harness({ signer: 1, prefix, packets: [] })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(card(h)).toBeUndefined()
      expect(h.form.querySelector('[data-phone-offer]')!.getAttribute('aria-label')).toBe('Send with passkey, confirmed with this phone')
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body).not.toHaveProperty('packetSha256')
    })
    it(`${prefix}: Send as message only is the form's own submit, never taken by the phone path`, async () => {
      const h = harness({ signer: 1, prefix, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      let prevented = 0, stopped = 0
      h.form.listeners.submit({ submitter: h.send, preventDefault: () => { prevented++ }, stopImmediatePropagation: () => { stopped++ } }); await flush()
      expect([prevented, stopped]).toEqual([0, 0])
      expect(h.requests.some(q => q.path === '/api/web-key/handoff')).toBe(false)
    })
    // 7.0.56 (Miles 18:3x): Enter takes the plain send, the form's own submit; the passkey path is never taken.
    it(`${prefix}: Enter (a submit with no submitter) takes the plain send, not the passkey`, async () => {
      const h = harness({ signer: 1, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      let prevented = 0, stopped = 0
      h.form.listeners.submit({ submitter: null, preventDefault: () => { prevented++ }, stopImmediatePropagation: () => { stopped++ } }); await flush()
      expect([prevented, stopped]).toEqual([0, 0])
      expect(h.requests.some(q => q.path === '/api/web-key/handoff')).toBe(false)
    })
    // The lead 18:5x: the request-card state is not flipped. Enter there still takes Approve and send, as today.
    it(`${prefix}: with a request card up, Enter still takes Approve and send (unchanged)`, async () => {
      const h = harness({ signer: 1, prefix, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.classList.contains('pa-req')).toBe(true)
      let prevented = 0, stopped = 0
      h.form.listeners.submit({ submitter: null, preventDefault: () => { prevented++ }, stopImmediatePropagation: () => { stopped++ } }); await flush()
      expect([prevented, stopped]).toEqual([1, 1])
      expect(h.requests.filter(q => q.path === '/api/web-key/handoff')).toHaveLength(1)
    })
    it(`${prefix}: with a request card up, Approve and send keeps its place beside the words and the quiet send its words (unchanged)`, async () => {
      const h = harness({ signer: 1, prefix, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      const go = h.form.querySelector('[data-phone-offer]')!
      expect(h.input.nextSibling).toBe(go)
      expect(go.innerHTML).toContain('Approve and send')
      expect(h.send.textContent).toBe('Send as message only')
    })
  }
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: a newer request arriving later never swaps the carried one under his thumb; it only adds to the count (lead 08:0x)`, async () => {
      const first = { ...PACKET, version: '7.0.6' }, newer = { ...PACKET, version: '7.0.7', createdAt: PACKET.createdAt + 60000 }
      const opts: any = { signer: 1, prefix, text: '', packets: [{ packet: first, packetSha256: 'b'.repeat(64) }] }
      const h = harness(opts)
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.r.phonePacketSha256).toBe('b'.repeat(64))
      expect([...card(h).children].find((c: any) => c.className === 'pa-more')).toBeUndefined()
      opts.packets = [{ packet: first, packetSha256: 'b'.repeat(64) }, { packet: newer, packetSha256: 'f'.repeat(64) }]
      h.pageShow(); await flush()                               // a repaint in the same opening
      expect(h.r.phonePacketSha256).toBe('b'.repeat(64))
      const c = card(h)
      expect(c.children[0].children[0].children[2].textContent).toBe('7.0.6')
      expect([...c.children].find((e: any) => e.className === 'pa-more').textContent).toBe('1 of 2 requests. A newer one arrived; reopen this session to see it.')
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body).toMatchObject({ packetSha256: 'b'.repeat(64), prompt: 'Approve publish @gotcos/glasses-server 7.0.6 on npm-latest.' })
    })
    it(`${prefix}: a carried request that expires gives way to the newest, and the count says so`, async () => {
      const first = { ...PACKET, version: '7.0.6' }, newer = { ...PACKET, version: '7.0.7', createdAt: PACKET.createdAt + 60000 }
      const opts: any = { signer: 1, prefix, packets: [{ packet: first, packetSha256: 'b'.repeat(64) }] }
      const h = harness(opts)
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      opts.packets = [{ packet: { ...first, exp: Date.now() - 600000 }, packetSha256: 'b'.repeat(64) }, { packet: newer, packetSha256: 'f'.repeat(64) }]
      h.pageShow(); await flush()
      expect(h.r.phonePacketSha256).toBe('f'.repeat(64))
      expect([...card(h).children].find((e: any) => e.className === 'pa-more')).toBeUndefined()
    })
    it(`${prefix}: a new opening of the session (a new reading) chooses the newest again`, async () => {
      const first = { ...PACKET, version: '7.0.6' }, newer = { ...PACKET, version: '7.0.7', createdAt: PACKET.createdAt + 60000 }
      const h = harness({ signer: 1, prefix, packets: [{ packet: first, packetSha256: 'b'.repeat(64) }, { packet: newer, packetSha256: 'f'.repeat(64) }] })
      h.r.phoneCarried = undefined
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.r.phonePacketSha256).toBe('f'.repeat(64))
      expect([...card(h).children].find((e: any) => e.className === 'pa-more').textContent).toBe('1 of 2 requests, newest shown.')
    })
    it(`${prefix}: a hostile packet shows only fixed text and its own fields as plain text (Q1 K22)`, async () => {
      const hostile = { ...PACKET, channel: 'mac-local', action: 'install', artifact: '<img src=x onerror=alert(1)>', effect: 'HOSTILE effect line', title: 'HOSTILE title', does: 'HOSTILE does' }
      const h = harness({ signer: 1, prefix, packets: [{ packet: hostile, packetSha256: 'b'.repeat(64) }] })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      const c = card(h), all = (e: any): string => e.textContent + e.innerHTML + e.children.map(all).join('')
      expect(all(c)).not.toContain('HOSTILE')
      expect(c.children[1].children[0].textContent).toBe(h.CHANNEL['mac-local'])
      // The artifact is text, never markup: set as textContent, no innerHTML anywhere in the card.
      expect(c.children[0].children[0].children[1].textContent).toBe('<img src=x onerror=alert(1)>')
      const html = (e: any): string => e.innerHTML + e.children.map(html).join('')
      expect(html(c)).toBe('')
    })
  }
  it('a stale selected packet fails rather than silently falling back to message authority', async () => {
    const h = harness({ signer: 1 })
    h.r.phonePacketSha256 = 'd'.repeat(64); h.r.phonePackets = {}
    expect(await h.approveOnPhone()).toBe('packet')
    expect(h.requests).toEqual([])
    expect(h.assigned).toEqual([])
  })
  it('the channel lines are the approval page\'s own fixed table, copied exactly (web-signer/signer-proof.js)', () => {
    const SP = readFileSync(join(HERE, '..', 'web-signer', 'signer-proof.js'), 'utf8')
    const m = /var CHANNEL_EFFECT = (\{[^\n]*\})\n/.exec(SP)!
    expect(new Function('return ' + m[1])()).toEqual(harness({ signer: 1 }).CHANNEL)
  })
  it('Today-prefix late packet list cannot paint into a closed or replaced overlay', async () => {
    let finish!: (value: any) => void
    const h = harness({ signer: 1, prefix: 'ta', packetRead: new Promise(resolve => { finish = resolve }) })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    h.liveView.active = false
    finish({ status: 200, body: { ok: true, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] } }); await flush()
    expect([...h.chat.children].find((c: any) => c.attrs['data-phone-card'])).toBeUndefined()
    expect(await h.approveOnPhone(h.viewOpts)).toBe('stale')
    expect(h.requests.some(q => q.path === '/api/web-key/handoff')).toBe(false)
    expect(h.assigned).toEqual([])
  })
  it('Today uses the same picker and handoff, not a separate authority path', () => {
    const today = readFileSync(join(HERE, 'panes', 'today-actions.js'), 'utf8')
    expect(today).toContain('K.phoneOffer(r, phoneApprovalOptions(r))')
    expect(today).toContain('K.approvePhone(phoneApprovalOptions(O.r))')
    expect(APP).toContain('phoneOffer: paintWebKeyOffer, approvePhone: approveOnPhone')
  })
})

describe('phone setup and revocation after Safari persisted return', () => {
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: persisted return replaces setup with approval after enrollment, and approval with setup after revocation`, async () => {
      const opts = { signer: 1, activeKeys: 0, prefix, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] }
      const h = harness(opts)
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.querySelector('[data-phone-setup]')).not.toBeNull()
      opts.activeKeys = 1
      h.pageShow(); await flush()
      expect(h.form.querySelector('[data-phone-setup]')).toBeNull()
      expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
      // 7.0.51: the request card, not a picker; the newest request is the one shown and carried.
      expect([...h.chat.children].find((c: any) => c.attrs['data-phone-card'])).toBeDefined()
      expect(h.r.phonePacketSha256).toBe('b'.repeat(64))
      opts.activeKeys = 0
      h.pageShow(); await flush()
      expect(h.form.querySelector('[data-phone-setup]')).not.toBeNull()
      // Revoked: the card goes and the composer is 7.0.50's again (its Send, its placeholder).
      expect([...h.chat.children].find((c: any) => c.attrs['data-phone-card'])).toBeUndefined()
      expect(h.form.classList.contains('pa-on')).toBe(false)
      expect(h.send.textContent).toBe('Send')
      expect(h.input.getAttribute('placeholder')).toBe('Continue this session…')
      expect(h.r.phonePacketSha256).toBe('')
      expect(h.r.phonePackets).toEqual({})
      expect(h.requests.filter(q => q.path === '/api/web-key/status')).toHaveLength(3)
      expect(h.requests.some(q => q.path === '/api/web-key/handoff')).toBe(false)
      expect(h.assigned).toEqual([])
    })
    it(`${prefix}: non-persisted pageshow and capability-off return have no extra effects`, async () => {
      const h = harness({ signer: 0, activeKeys: 0, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); h.pageShow(false); h.pageShow(); await flush()
      expect(h.requests).toEqual([])
      expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
      const on = harness({ signer: 1, activeKeys: 0, prefix })
      on.paintWebKeyOffer(on.r, on.viewOpts); await flush()
      on.pageShow(false); await flush()
      expect(on.requests).toHaveLength(1)
    })
    it(`${prefix}: an old status response cannot overwrite a fresh enrolled-key return`, async () => {
      let old!: (value: any) => void
      let reads = 0
      const h = harness({ signer: 1, prefix, statusRead: () => ++reads === 1 ? new Promise(resolve => { old = resolve }) : Promise.resolve({ status: 200, body: { ok: true, activeKeys: 1 } }) })
      h.paintWebKeyOffer(h.r, h.viewOpts)
      h.pageShow(); await flush()
      expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
      old({ status: 200, body: { ok: true, activeKeys: 0 } }); await flush()
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.querySelector('[data-phone-setup]')).toBeNull()
      expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
      expect(reads).toBe(2)
    })
    it(`${prefix}: a late old packet list cannot reappear after revocation`, async () => {
      let old!: (value: any) => void
      const opts = { signer: 1, activeKeys: 1, prefix, packetRead: new Promise(resolve => { old = resolve }) }
      const h = harness(opts)
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
      opts.activeKeys = 0; h.pageShow(); await flush()
      expect(h.form.querySelector('[data-phone-setup]')).not.toBeNull()
      old({ status: 200, body: { ok: true, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] } }); await flush()
      expect(h.form.querySelector('[data-phone-packets]')).toBeNull()
      expect(h.r.phonePackets).toEqual({})
    })
    for (const changed of ['closed', 'replaced-form'] as const) {
      it(`${prefix}: persisted return prunes ${changed} views without status or DOM work`, async () => {
        const h = harness({ signer: 1, activeKeys: 0, prefix })
        h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
        const original = h.form.querySelector('[data-phone-offer]')
        if (changed === 'closed') h.liveView.active = false
        else h.replaceForm()
        h.pageShow(); await flush()
        expect(h.requests).toHaveLength(1)
        expect(h.form.querySelector('[data-phone-offer]')).toBe(original)
      })
    }
    it(`${prefix}: unavailable status on return removes stale approval without claiming no key`, async () => {
      let reads = 0
      const h = harness({ signer: 1, prefix, statusRead: async () => ++reads === 1 ? { status: 200, body: { ok: true, activeKeys: 1 } } : { status: 503, body: { ok: false } } })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.querySelector('[data-phone-offer]')).not.toBeNull()
      h.pageShow(); await flush()
      expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
      expect(h.form.querySelector('[data-phone-packets]')).toBeNull()
      expect(reads).toBe(2)
    })
  }
  it('repeated return events and two current readers share one new-epoch status request', async () => {
    let reads = 0, finish!: (value: any) => void
    const h = harness({ signer: 1, activeKeys: 0, statusRead: () => ++reads === 1 ? Promise.resolve({ status: 200, body: { ok: true, activeKeys: 0 } }) : new Promise(resolve => { finish = resolve }) })
    const today = h.addView('ta')
    h.paintWebKeyOffer(h.r, h.viewOpts); h.paintWebKeyOffer(h.r, today.opts); await flush()
    expect(reads).toBe(1)
    expect(today.form.querySelector('[data-phone-setup]')).not.toBeNull()
    h.pageShow(); h.pageShow(); h.pageShow()
    expect(reads).toBe(2)
    finish({ status: 200, body: { ok: true, activeKeys: 1 } }); await flush()
    expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
    expect(today.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
    expect(h.form.querySelector('[data-phone-setup]')).toBeNull()
    expect(today.form.querySelector('[data-phone-setup]')).toBeNull()
    expect(reads).toBe(2)
  })
  it('ordinary paint reuses a fresh status and refreshes after the bounded cache age without a timer', async () => {
    const opts = { signer: 1, activeKeys: 0 }
    const h = harness(opts)
    h.paintWebKeyOffer(h.r); await flush()
    opts.activeKeys = 1; h.advance(29999)
    h.paintWebKeyOffer(h.r); await flush()
    expect(h.form.querySelector('[data-phone-setup]')).not.toBeNull()
    expect(h.requests).toHaveLength(1)
    h.advance(2); h.paintWebKeyOffer(h.r); await flush()
    expect(h.form.querySelector('[data-phone-setup]')).toBeNull()
    expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
    expect(h.requests.filter(q => q.path === '/api/web-key/status')).toHaveLength(2)
  })
})

describe('phone navigation owns only its own busy state', () => {
  for (const prefix of ['session', 'ta'] as const) {
    // 7.0.51 (W1, lead 06:5x): this test used to pin a NEW turn key for the second approval. That encoded the
    // fault, not a need: a second approval of the same words is either a retry of one that never landed (the same
    // key delivers it once) or a repeat of one that did (the same key is answered as already sent, as a plain Send
    // of the same words is). A deliberately repeated message is typed again after the box clears, like Send.
    it(`${prefix}: opened approval returns from BFCache and a second approval of the same words keeps its turn key`, async () => {
      const h = harness({ signer: 1, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.r.sending).toBeTruthy()
      h.pageShow(); await flush()
      expect(h.r.sending).toBe(false)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const posts = h.requests.filter(q => q.path === '/api/web-key/handoff')
      expect(posts).toHaveLength(2)
      expect(posts[1].body.clientTurnId).toBe(posts[0].body.clientTurnId)
      expect(h.assigned).toHaveLength(2)
    })
    it(`${prefix}: ordinary-send busy is preserved on persisted return`, async () => {
      const h = harness({ signer: 1, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      h.r.sending = true
      h.pageShow(); await flush()
      expect(h.r.sending).toBe(true)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('busy')
      expect(h.requests.some(q => q.path === '/api/web-key/handoff')).toBe(false)
    })
    it(`${prefix}: a newer ordinary send cannot be unlocked by the old completed phone navigation`, async () => {
      const h = harness({ signer: 1, prefix })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.r.sending = true
      h.pageShow(); await flush()
      expect(h.r.sending).toBe(true)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('busy')
    })
    it(`${prefix}: a pending phone operation is not reset by return before navigation completed`, async () => {
      let finish!: (value: any) => void
      const h = harness({ signer: 1, prefix, handoff: () => new Promise(resolve => { finish = resolve }) })
      const pending = h.approveOnPhone(h.viewOpts); await flush()
      const owner = h.r.sending
      expect(owner).toBeTruthy()
      h.pageShow(); await flush()
      expect(h.r.sending).toBe(owner)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('busy')
      finish({ status: 201, body: { ok: true, signerUrl: `https://${HOST}:3144/#h=${'h'.repeat(24)}` } })
      expect(await pending).toBe('opened')
      h.pageShow(); await flush()
      expect(h.r.sending).toBe(false)
    })
    it(`${prefix}: a stale handoff response cannot navigate or clear a newer ordinary busy owner`, async () => {
      let finish!: (value: any) => void
      const h = harness({ signer: 1, prefix, handoff: () => new Promise(resolve => { finish = resolve }) })
      const pending = h.approveOnPhone(h.viewOpts); await flush()
      h.r.sending = true
      finish({ status: 201, body: { ok: true, signerUrl: `https://${HOST}:3144/#h=${'h'.repeat(24)}` } })
      expect(await pending).toBe('stale')
      expect(h.r.sending).toBe(true)
      expect(h.assigned).toEqual([])
      h.pageShow(); await flush()
      expect(h.r.sending).toBe(true)
    })
    it(`${prefix}: navigation failure releases its own busy state but not a newer owner`, async () => {
      const own = harness({ signer: 1, prefix, navigate: () => { throw new Error('blocked navigation') } })
      expect(await own.approveOnPhone(own.viewOpts)).toBe('failed')
      expect(own.r.sending).toBe(false)
      expect(own.assigned).toEqual([])
      let newer!: ReturnType<typeof harness>
      newer = harness({ signer: 1, prefix, navigate: () => { newer.r.sending = true; throw new Error('blocked navigation') } })
      expect(await newer.approveOnPhone(newer.viewOpts)).toBe('failed')
      expect(newer.r.sending).toBe(true)
      newer.pageShow(); await flush()
      expect(newer.r.sending).toBe(true)
      expect(newer.assigned).toEqual([])
    })
    it(`${prefix}: a rejected old handoff cannot clear a newer phone busy owner`, async () => {
      let reject!: (err: Error) => void
      const h = harness({ signer: 1, prefix, handoff: () => new Promise((_resolve, fail) => { reject = fail }) })
      const pending = h.approveOnPhone(h.viewOpts); await flush()
      const next = { completed: false }
      h.r.sending = next; h.r.phoneNavigation = next
      reject(new Error('offline'))
      expect(await pending).toBe('failed')
      expect(h.r.sending).toBe(next)
      expect(h.r.phoneNavigation).toBe(next)
      h.pageShow(); await flush()
      expect(h.r.sending).toBe(next)
    })
  }
})

describe('bounded status refresh uses the real apiAnswer transport', () => {
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: aborting a hung persisted-return status releases refresh ownership for a later healthy return`, async () => {
      let reads = 0, aborts = 0
      const h = harness({ signer: 1, prefix, statusWire: async (path, init) => {
        expect(path).toBe('/api/web-key/status')
        expect(init.method).toBe('GET')
        expect(init.credentials).toBe('same-origin')
        if (++reads === 2) return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => { aborts += 1; const err = new Error('aborted'); err.name = 'AbortError'; reject(err) }, { once: true })
        })
        return { status: 200, text: async () => JSON.stringify({ ok: true, activeKeys: 1 }) }
      } })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.form.querySelector('[data-phone-offer]')).not.toBeNull()
      h.pageShow(); h.pageShow(); await flush()
      expect(reads).toBe(2)
      expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
      expect(h.statusTimeouts).toEqual([15000, 15000])
      expect(h.timeoutDelays).toEqual([15000, 15000])
      expect(h.timerCount()).toBe(1)
      h.expireTimers(); await flush()
      expect(aborts).toBe(1)
      expect(h.timerCount()).toBe(0)
      expect(h.downMarks).not.toContain(false)
      h.pageShow(); await flush()
      expect(reads).toBe(3)
      expect(h.form.querySelector('[data-phone-offer]')?.className).toBe('pa-go')
      expect(h.form.querySelector('[data-phone-setup]')).toBeNull()
      expect(h.timerCount()).toBe(0)
      expect(h.statusTimeouts).toEqual([15000, 15000, 15000])
    })
  }
})

describe('7.0.51: one turn key for the phone and Send, and a landing check on return (W1, lead 06:5x)', () => {
  const landed = (outcome: string) => () => ({ status: 200, body: { outcome, recordedStatus: 202, polled: true } })
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: after a verified send and the return, Send and a re-tap carry the phone's turn key, so the Mac takes it once`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.' })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const phoneKey = h.requests.filter(q => q.path === '/api/web-key/handoff')[0].body.clientTurnId
      h.pageShow(); await flush()
      // Words still in the box (the Mac has no record yet): the plain Send would post this key.
      expect(h.input.value.trim()).toBe('Ship it.')
      expect(h.plainKey()).toBe(phoneKey)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const posts = h.requests.filter(q => q.path === '/api/web-key/handoff')
      expect(posts.map(q => q.body.clientTurnId)).toEqual([phoneKey, phoneKey])
    })
    it(`${prefix}: a plain Send first, then the phone with the same words, also share one key`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.' })
      const plain = h.plainKey()
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.requests.filter(q => q.path === '/api/web-key/handoff')[0].body.clientTurnId).toBe(plain)
    })
    it(`${prefix}: the return reads that turn by its key, and a landed turn leaves the box and says so`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed('completed') })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const key = h.requests.filter(q => q.path === '/api/web-key/handoff')[0].body.clientTurnId
      h.pageShow(); await flush()
      expect(h.requests.map(q => q.path)).toContain('/api/agent-sessions/bindings/b-1/turns/' + key)
      expect(h.input.value).toBe('')
      expect(h.statuses.at(-1)?.[0]).toBe('Sent from your phone.')
    })
    it(`${prefix}: queued counts as landed too`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed('queued') })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.pageShow(); await flush()
      expect(h.input.value).toBe('')
    })
    // 7.0.51 (lead 08:4x): the words follow what the turn ledger actually KNOWS. It stores only completed, ambiguous and
    // a post-202 refused; a 404 also covers a turn admitted and still running, so it never reads as "did not take".
    // `sameKey`: the words are kept under the trip's key (a resend replays, never posts twice), or get a fresh one.
    for (const [name, reply, line, sameKey] of [
      ['no record (404)', () => ({ status: 404, body: { outcome: 'unknown' } }), 'The Mac has no record of that message yet. Your words are still here; sending again will not post twice.', true],
      ['still pending', () => ({ status: 200, body: { outcome: 'pending' } }), 'Your message from the phone is still on its way. Your words are still here; sending again will not post twice.', true],
      ['a refusal the Mac recorded', () => ({ status: 200, body: { outcome: 'refused', reasonCopy: 'The session is working.' } }), 'The Mac did not take the message from your phone. Your words are still here to send again.', false],
      ['an ambiguous delivery', () => ({ status: 200, body: { outcome: 'ambiguous', retryable: false } }), 'COS cannot tell whether your message from the phone reached the session. Your words are still here; look at the session before sending them again.', true],
      ['an unreadable answer', () => ({ status: 503, body: { outcome: 'unavailable' } }), 'COS could not check whether your phone sent it. Your words are still here; sending again will not post twice.', true],
      // Only a 200 (the turn ledger's own record) is evidence; any other status is not, whatever its body says.
      ['a non-200 whose body claims it landed', () => ({ status: 409, body: { outcome: 'completed' } }), 'COS could not check whether your phone sent it. Your words are still here; sending again will not post twice.', true],
      ['a non-200 whose body claims a refusal', () => ({ status: 409, body: { outcome: 'refused' } }), 'COS could not check whether your phone sent it. Your words are still here; sending again will not post twice.', true],
      ['a non-200 whose body claims ambiguity', () => ({ status: 409, body: { outcome: 'ambiguous' } }), 'COS could not check whether your phone sent it. Your words are still here; sending again will not post twice.', true],
      // A 200 the ledger never sends (F1's mock: no outcome) is not a refusal: it is "could not check".
      ['a bare 200 with no outcome', () => ({ status: 200, body: {} }), 'COS could not check whether your phone sent it. Your words are still here; sending again will not post twice.', true],
      ['a 200 with an outcome this page does not know', () => ({ status: 200, body: { outcome: 'surprise' } }), 'COS could not check whether your phone sent it. Your words are still here; sending again will not post twice.', true],
    ] as const) {
      it(`${prefix}: ${name} keeps the words and says so`, async () => {
        const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: reply })
        expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
        const key = h.requests.filter(q => q.path === '/api/web-key/handoff')[0].body.clientTurnId
        h.pageShow(); await flush()
        expect(h.input.value.trim()).toBe('Ship it.')
        expect(h.statuses.at(-1)?.[0]).toBe(line)
        if (sameKey) expect(h.plainKey()).toBe(key)
        else expect(h.plainKey()).not.toBe(key)
      })
    }
    it(`${prefix}: a refusal re-keys only the refused words; other words typed since keep their own key`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: () => ({ status: 200, body: { outcome: 'refused' } }) })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.input.value = 'Other words.'
      const other = h.plainKey()
      h.pageShow(); await flush()
      expect(h.input.value).toBe('Other words.')
      expect(h.plainKey()).toBe(other)
    })
    it(`${prefix}: a status read that fails keeps the words and says so`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: () => Promise.reject(new Error('offline')) as any })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.pageShow(); await flush()
      expect(h.input.value.trim()).toBe('Ship it.')
      expect(h.statuses.at(-1)?.[0]).toBe('COS could not check whether your phone sent it. Your words are still here; sending again will not post twice.')
    })
    it(`${prefix}: after a landed phone send, the same words typed again are a new message with a new key, as after Send`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed('completed') })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const key = h.requests.filter(q => q.path === '/api/web-key/handoff')[0].body.clientTurnId
      h.pageShow(); await flush()
      expect(h.input.value).toBe('')
      h.input.value = 'Ship it.'
      expect(h.plainKey()).not.toBe(key)
    })
    it(`${prefix}: words typed after the trip are never cleared by the landing check`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed('completed') })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.input.value = 'Ship it. And the docs.'
      h.pageShow(); await flush()
      expect(h.input.value).toBe('Ship it. And the docs.')
    })
    it(`${prefix}: a return with no phone trip makes no turn read`, async () => {
      const h = harness({ signer: 1, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      h.pageShow(); await flush()
      expect(h.requests.some(q => /\/turns\//.test(q.path))).toBe(false)
    })
  }
})

describe('7.0.51 item 6: a trip that never left the page releases itself, and says which case it was (W1, lead 06:5x)', () => {
  const landed = () => ({ status: 200, body: { outcome: 'completed' } })
  for (const prefix of ['session', 'ta'] as const) {
    for (const standalone of [true, false]) {
      it(`${prefix}${standalone ? ' (Home Screen app)' : ''}: no pagehide within the bound releases this trip's busy state, sends one numbers-only row, and reads the turn when he is back`, async () => {
        const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed, standalone })
        expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
        expect(h.r.sending).toBeTruthy()
        expect(h.tripTimers.map(t => t.ms)).toEqual([4000])
        h.advance(4000); h.runTripTimers(); await flush()
        expect(h.r.sending).toBe(false)
        expect(h.r.phoneNavigation).toBe(null)
        expect(h.crumbs).toHaveLength(1)
        const [what, data] = h.crumbs[0]
        expect(what).toBe('phone-trip')
        expect(data).toEqual({ case: 'stayed', standalone, ms: 4000, vis: 'v' })
        // Back on the page (it was hidden behind the approval page): one read of that turn by its key.
        expect(h.requests.some(q => /\/turns\//.test(q.path))).toBe(false)
        h.setVisible('hidden'); await flush()
        expect(h.requests.some(q => /\/turns\//.test(q.path))).toBe(false)
        h.setVisible('visible'); await flush()
        expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
        expect(h.input.value).toBe('')
        h.setVisible('hidden'); h.setVisible('visible'); await flush()
        expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
        expect(h.docListenerCount()).toBe(0)
      })
    }
    // Q1 07:06 (their T11): a navigation slower than the bound, which then returns from BFCache. The bound already
    // released it and read on the next visible; pageshow must not read it again or send a second row.
    it(`${prefix}: a slow navigation released by the bound, then restored from BFCache, is read exactly once`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: () => ({ status: 200, body: { outcome: 'completed' } }) })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.runTripTimers(); await flush()                          // 4 s, still on the page: stayed
      h.pageHide(); h.setVisible('hidden')                      // the slow navigation finally leaves
      h.pageShow(); h.setVisible('visible'); await flush()      // and comes back from BFCache
      expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
      expect(h.crumbs.map(c => c[1].case)).toEqual(['stayed'])
    })
    it(`${prefix}: a page that left (pagehide) and came back from BFCache is not released twice, and its row says bfcache`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.pageHide(); h.advance(9000); h.pageShow(); await flush()
      expect(h.r.sending).toBe(false)
      h.r.sending = true                 // a newer plain send started after the return
      h.runTripTimers(); await flush()   // the paused timer resumes after the restore
      expect(h.r.sending).toBe(true)
      expect(h.crumbs.map(c => c[0] + ':' + c[1].case)).toEqual(['phone-trip:bfcache'])
      expect(h.crumbs[0][1]).toEqual({ case: 'bfcache', standalone: false, ms: 9000, vis: 'v' })
      expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
      expect(h.windowListenerCount('pagehide')).toBe(0)
    })
    it(`${prefix}: a page that is leaving (pagehide, not yet restored) is never released by the bound`, async () => {
      const h = harness({ signer: 1, prefix })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const owner = h.r.sending
      h.pageHide(); h.runTripTimers(); await flush()
      expect(h.r.sending).toBe(owner)
      expect(h.crumbs).toEqual([])
    })
    it(`${prefix}: the bound never releases a newer plain send that took the busy state`, async () => {
      const h = harness({ signer: 1, prefix })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.r.sending = true
      h.runTripTimers(); await flush()
      expect(h.r.sending).toBe(true)
    })
    it(`${prefix}: an older trip's bound never touches a newer trip (its record, its busy state, its row)`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: () => ({ status: 200, body: { outcome: 'completed' } }) })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.r.sending = false; h.r.phoneNavigation = null           // the first trip was settled some other way
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const second = h.r.sending
      h.runTripTimer(0); await flush()                           // only the FIRST trip's bound fires
      expect(h.r.sending).toBe(second)
      expect(h.crumbs).toEqual([])
      h.pageHide(); h.pageShow(); await flush()                  // the second trip's return still reads its turn
      expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
    })
    it(`${prefix}: the bound never releases a newer owner`, async () => {
      const h = harness({ signer: 1, prefix })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const newer = { completed: false }
      h.r.sending = newer; h.r.phoneNavigation = newer
      h.runTripTimers(); await flush()
      expect(h.r.sending).toBe(newer)
      expect(h.r.phoneNavigation).toBe(newer)
    })
    it(`${prefix}: a refused or failed approval sets no trip timer`, async () => {
      const h = harness({ signer: 1, prefix, handoff: () => ({ status: 409, body: { ok: false, error: 'no_phone_key' } }) })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('refused')
      expect(h.tripTimers).toEqual([])
      expect(h.crumbs).toEqual([])
    })
  }
})

// 7.0.51 item 5 (W1, lead 06:5x, the default-on proof, H4): with no enrolled key, or phone approval off, Control Web
// sends exactly as 7.0.50. Every app.js change in 7.0.51 is inside the web-key block (checked at each cut against
// 33f8ab3e: outside the block the file is byte-identical), so the plain send paths are 7.0.50's own code; what is
// left to prove is that this block adds nothing to them in those states: no button, no request, no timer, no row,
// no turn read, and no change to the busy state or the draft, through paint and both kinds of return.
describe('7.0.51 item 5: no enrolled key, or approvals off, is 7.0.50 (W1)', () => {
  const STATES = [
    { name: 'approvals off (no webKeySigner capability)', opts: { signer: 0 }, requests: 0, setup: false },
    { name: 'approvals off on the Mac (status route 404)', opts: { signer: 1, statusRead: () => Promise.resolve({ status: 404, body: {} }) }, requests: 1, setup: false },
    { name: 'no enrolled key', opts: { signer: 1, activeKeys: 0 }, requests: 1, setup: true },
  ] as const
  for (const prefix of ['session', 'ta'] as const) {
    for (const st of STATES) {
      it(`${prefix}: ${st.name}: no approval, no trip, nothing on return`, async () => {
        const h = harness({ ...(st.opts as any), prefix })
        h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
        expect(h.form.querySelector('[data-action="approve-on-phone"],[data-ta="approve-phone"]')).toBeNull()
        expect(!!h.form.querySelector('[data-phone-setup]')).toBe(st.setup)
        expect(h.requests).toHaveLength(st.requests)
        h.pageHide(); h.pageShow(true); h.pageShow(false); h.setVisible('hidden'); h.setVisible('visible'); await flush()
        expect(h.requests.some(q => /\/turns\/|\/web-key\/handoff|\/attach|\/web-key\/packets/.test(q.path))).toBe(false)
        expect(h.tripTimers).toEqual([])
        expect(h.crumbs).toEqual([])
        expect(h.r.sending).toBe(false)
        expect(h.r.draft).toBe(null)
        expect(h.input.value).toBe('Yes, go ahead.  ')
        expect(h.statuses).toEqual([])
      })
    }
  }
})

describe('7.0.51 item 4: the draft survives the trip, and the return lands in the same session (W1, lead 06:5x)', () => {
  const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
  const landed = () => ({ status: 200, body: { outcome: 'completed' } })
  const trip = (over: Record<string, unknown> = {}) => ({ v: 1, provider: 'claude', id: SID, key: 'ct-key-trip01', bindingId: 'b-1', text: 'Ship it.', at: Date.now(), ...over })
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: an opened approval keeps one per-tab record: the session, the turn key, the binding and the words, nothing else`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.' })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const key = h.requests.filter(q => q.path === '/api/web-key/handoff')[0].body.clientTurnId
      const rec = JSON.parse(h.store.get('cos.phoneTrip')!)
      expect(Object.keys(rec).sort()).toEqual(['at', 'bindingId', 'id', 'key', 'provider', 'text', 'v'])
      expect(rec).toMatchObject({ v: 1, provider: 'claude', id: SID, key, bindingId: 'b-1', text: 'Ship it.' })
      expect(h.store.size).toBe(1)
    })
    it(`${prefix}: a refused approval keeps no record`, async () => {
      const h = harness({ signer: 1, prefix, handoff: () => ({ status: 409, body: { ok: false, error: 'no_phone_key' } }) })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('refused')
      expect(h.store.size).toBe(0)
    })
    it(`${prefix}: a fresh load of the same session puts the words back under the same key, reads the turn once, and drops the record`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: '', trip: trip(), turnStatus: () => ({ status: 404, body: { outcome: 'unknown' } }) })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('Ship it.')
      expect(h.plainKey()).toBe('ct-key-trip01')
      expect(h.requests.filter(q => /\/turns\//.test(q.path)).map(q => q.path)).toEqual(['/api/agent-sessions/bindings/b-1/turns/ct-key-trip01'])
      expect(h.crumbs.map(c => c[1].case)).toEqual(['fresh'])
      expect(h.store.size).toBe(0)
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
    })
    it(`${prefix}: a fresh load after it landed clears the restored words`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: '', trip: trip(), turnStatus: landed })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('')
      expect(h.statuses.at(-1)?.[0]).toBe('Sent from your phone.')
    })
    it(`${prefix}: words already in the box are never overwritten by the record`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: 'Something else.', trip: trip(), turnStatus: landed })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('Something else.')
    })
    it(`${prefix}: another session never gets the words, and the record waits for its own session`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: '', trip: trip({ id: 'other-session-0000' }) })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('')
      expect(h.requests.some(q => /\/turns\//.test(q.path))).toBe(false)
      expect(h.store.size).toBe(1)
    })
    it(`${prefix}: a record older than 30 minutes is dropped without restoring anything`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: '', trip: trip({ at: Date.now() - 31 * 60000 }) })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('')
      expect(h.requests.some(q => /\/turns\//.test(q.path))).toBe(false)
      expect(h.store.size).toBe(0)
    })
    it(`${prefix}: a malformed record is dropped and nothing is restored`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: '', trip: '{not json' })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('')
      expect(h.store.size).toBe(0)
    })
    it(`${prefix}: the BFCache return handles the trip itself, so its record is dropped and read only once`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.pageHide(); h.pageShow(); await flush()
      expect(h.store.size).toBe(0)
      expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
      expect(h.crumbs.map(c => c[1].case)).toEqual(['bfcache'])
    })
    // Lead 08:3x (Codex's review of 19ecc975): a page that stayed (a Home Screen app that opened the approval page in
    // a sheet or in Safari) may be reloaded or evicted before he comes back, so its record lives on to its normal expiry.
    it(`${prefix}: a BFCache return that did NOT land still drops the record (this page handles its own trip)`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: () => ({ status: 404, body: { outcome: 'unknown' } }) })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.store.size).toBe(1)
      h.pageHide(); h.pageShow(); await flush()
      expect(h.input.value.trim()).toBe('Ship it.')
      expect(h.store.size).toBe(0)
    })
    it(`${prefix}: a trip that stayed on the page KEEPS its record, so a later #/phone-return load still has it`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.' })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.runTripTimers(); await flush()
      expect(h.store.size).toBe(1)
      expect(h.r.sending).toBe(false)
    })
    it(`${prefix}: a stayed trip that is read as landed when he comes back drops its record`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', turnStatus: landed })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.runTripTimers(); h.setVisible('hidden'); h.setVisible('visible'); await flush()
      expect(h.input.value).toBe('')
      expect(h.store.size).toBe(0)
    })
    it(`${prefix}: an ORDINARY load (no #/phone-return) never acts on the record: no words, no read, the record kept`, async () => {
      const h = harness({ signer: 1, prefix, text: '', trip: trip(), turnStatus: landed })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('')
      expect(h.requests.some(q => /\/turns\//.test(q.path))).toBe(false)
      expect(h.crumbs).toEqual([])
      expect(h.store.size).toBe(1)
    })
    it(`${prefix}: after a #/phone-return load has acted, a NEW trip that stays is not acted on by a later repaint of that page`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: '', trip: trip(), turnStatus: () => ({ status: 404, body: { outcome: 'unknown' } }) })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()          // the return: words back, one read
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')   // he approves again on the same page
      h.runTripTimers(); await flush()                             // and it stays: the record is kept
      expect(h.store.size).toBe(1)
      h.input.value = ''
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()          // an ordinary repaint of that page
      expect(h.input.value).toBe('')
      expect(h.store.size).toBe(1)
      expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
    })
    it(`${prefix}: a #/phone-return load acts once: a second paint in the same load does nothing more`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 1, prefix, text: '', trip: trip(), turnStatus: () => ({ status: 404, body: { outcome: 'unknown' } }) })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      h.input.value = ''
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.requests.filter(q => /\/turns\//.test(q.path))).toHaveLength(1)
      expect(h.input.value).toBe('')
    })
    it(`${prefix}: a navigation that fails keeps no record`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', navigate: () => { throw new Error('blocked navigation') } })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('failed')
      expect(h.store.size).toBe(0)
    })
    it(`${prefix}: the words come back even if phone approval was turned off while he was away`, async () => {
      const h = harness({ hash: '#/phone-return', signer: 0, prefix, text: '', trip: trip(), turnStatus: () => ({ status: 404, body: { outcome: 'unknown' } }) })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.input.value).toBe('Ship it.')
      expect(h.plainKey()).toBe('ct-key-trip01')
      expect(h.form.querySelector('[data-phone-offer]')).toBeNull()
    })
    it(`${prefix}: storage that throws never stops the approval or the return`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Ship it.', storageThrows: true, turnStatus: landed })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      h.pageHide(); h.pageShow(); await flush()
      expect(h.input.value).toBe('')
    })
  }
  it('a load at #/phone-return opens the session the record names, replacing the address (history.replaceState: no entry, no hashchange)', () => {
    const h = harness({ signer: 1, hash: '#/phone-return', trip: trip() })
    expect(h.replaced).toEqual(['/control/#/sessions/claude/' + SID])
    expect(h.store.size).toBe(1)
  })
  it('a load at #/phone-return with no record, an old one or a broken one opens Today', () => {
    for (const t of [undefined, trip({ at: Date.now() - 31 * 60000 }), '{x']) {
      const h = harness({ signer: 1, hash: '#/phone-return', trip: t as any })
      expect(h.replaced).toEqual(['/control/#/today'])
    }
  })
  it('any other address is left alone at load', () => {
    for (const hash of ['', '#/sessions', '#/today', '#/phone-return/x', '#phone-return']) {
      const h = harness({ signer: 1, hash, trip: trip() })
      expect(h.replaced).toEqual([])
    }
  })
})

describe('7.0.51 item 3: what the plain Send parks, holds, wraps or asks about is decided before he leaves (W1, option A)', () => {
  const PK = (sha = 'b'.repeat(64)) => [{ packet: PACKET, packetSha256: sha }]
  const go = (h: any) => h.form.querySelector('[data-phone-offer]')
  const note = (h: any) => h.form.querySelector('[data-phone-busy]')
  for (const prefix of ['session', 'ta'] as const) {
    it(`${prefix}: while the session works, Approve waits and says why, the quiet send queues, and nothing is opened or spent`, async () => {
      const h = harness({ signer: 1, prefix, packets: PK() })
      h.r.live = { working: true }
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(go(h).disabled).toBe(true)
      expect(note(h).textContent).toBe('Claude is working. Approve opens when it stops, so your passkey is not spent on a refusal.')
      expect(go(h).getAttribute('aria-describedby')).toBe(prefix + '-phone-busy')
      expect(h.send.textContent).toBe('Queue as message only')
      expect(await h.approveOnPhone(h.viewOpts)).toBe('waits')
      expect(h.requests.some(q => /\/attach|\/web-key\/handoff/.test(q.path))).toBe(false)
      expect(h.assigned).toEqual([])
      expect(h.r.sending).toBe(false)
      // It stops working: the repaint (sxSettle) opens it again.
      h.r.live.working = false; h.phoneBusyPaint(h.r)
      expect(go(h).disabled).toBe(false)
      expect(note(h)).toBeNull()
      expect(go(h).getAttribute('aria-describedby')).toBe(null)
      expect(h.send.textContent).toBe('Send as message only')   // the request card is still up: today's words (lead 18:5x)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
    })
    // 7.0.56: with no request it is Send with passkey that waits, in the one note (its middle sentence, sxParkLine's own
    // form, comes from outside this block: sessions-dock-web.test.ts pins all five); the plain send queues.
    it(`${prefix}: with no request it is Send with passkey that waits, Codex is named as Codex, and the plain send says Queue message`, async () => {
      const h = harness({ signer: 1, prefix })
      h.r.provider = 'codex'; h.r.live = { working: true }
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(note(h).textContent).toBe('Codex is working. Send with passkey opens when it stops.')
      expect(go(h).disabled).toBe(true)
      expect(h.send.textContent).toBe('Queue message')
    })
    for (const [name, set, line] of [
      ['a message held for after the reply', (r: any) => { r.held = [{ text: 'x', key: 'k1' }] }, 'A message is waiting to go after this reply. Send with passkey opens once it has gone.'],
      ['the write gate busy (the server said so)', (r: any) => { r.gate = { busy: true, at: Date.now() } }, 'Claude is working. Send with passkey opens when it stops.'],
    ] as const) {
      it(`${prefix}: ${name}: the phone send waits with its reason, the quiet send is unchanged`, async () => {
        const h = harness({ signer: 1, prefix })
        set(h.r)
        h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
        expect(go(h).disabled).toBe(true)
        expect(note(h).textContent).toBe(line)
        // Working (the gate busy) can wait in line; a hold or a question cannot.
        expect(h.send.textContent).toBe(name.startsWith('the write gate') ? 'Queue message' : 'Send')
        expect(await h.approveOnPhone(h.viewOpts)).toBe('waits')
        expect(h.requests.some(q => /\/attach|\/web-key\/handoff/.test(q.path))).toBe(false)
      })
    }
    it(`${prefix}: an open end-of-turn question with the session idle does not hold it: his exact words go, with no question id (lead 07:3x)`, async () => {
      const h = harness({ signer: 1, prefix, text: 'Yes, install it.' })
      h.r.turnEnd = true; h.r.row = { ask: { q: 'Install @gotcos/glasses-server 7.0.51?' } }
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(go(h).disabled).toBe(false)
      expect(note(h)).toBeNull()
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      const body = h.requests.find(q => q.path === '/api/web-key/handoff')!.body
      expect(body.prompt).toBe('Yes, install it.')
      expect(body).not.toHaveProperty('turnEndAskId')
    })
    it(`${prefix}: a send already on its way says so in one plain line and opens nothing`, async () => {
      const h = harness({ signer: 1, prefix })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      h.r.sending = true
      expect(await h.approveOnPhone(h.viewOpts)).toBe('busy')
      expect(h.statuses.at(-1)?.[0]).toBe('A send is already on its way. Wait for it to land, then try again.')
      expect(h.requests.some(q => /\/attach|\/web-key\/handoff/.test(q.path))).toBe(false)
    })
    it(`${prefix}: the caution is ASKED first (lead 07:3x), nothing is opened until he answers it`, async () => {
      let asked = 0
      const h = harness({ signer: 1, prefix })
      h.r.verdict = { caution: true }
      const opts = prefix === 'ta' ? { ...h.viewOpts, askCaution: () => { asked++ } } : h.viewOpts
      h.paintWebKeyOffer(h.r, opts); await flush()
      expect(go(h).disabled).toBe(false)
      expect(await h.approveOnPhone(opts)).toBe('caution')
      if (prefix === 'ta') expect(asked).toBe(1)
      else expect([h.r.cautionAsk, h.r.cautionVia]).toEqual([true, 'phone'])
      expect(h.requests.some(q => /\/attach|\/web-key\/handoff/.test(q.path))).toBe(false)
      h.r.cautionAck = true
      expect(await h.approveOnPhone(opts)).toBe('opened')
    })
    it(`${prefix}: with the changed box up, approving carries its Send anyway revision (lead 07:3x)`, async () => {
      const h = harness({ signer: 1, prefix })
      h.r.refusal = { changed: true, fork: true }; h.r.sendAnyway = 'rev-0123abcd'
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(go(h).disabled).toBe(false)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body.acknowledgedRevision).toBe('rev-0123abcd')
    })
    it(`${prefix}: with no changed box, no revision is carried`, async () => {
      const h = harness({ signer: 1, prefix })
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
      expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body).not.toHaveProperty('acknowledgedRevision')
    })
    it(`${prefix}: a cancelled held message, a closed question and an acknowledged caution do not hold it`, async () => {
      const h = harness({ signer: 1, prefix })
      h.r.held = [{ text: 'x', key: 'k1', cancelled: true }]; h.r.turnEnd = true; h.r.row = {}; h.r.verdict = { caution: true }; h.r.cautionAck = true
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(go(h).disabled).toBe(false)
      expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
    })
  }
  it('one session going busy never greys out another session\'s composer', async () => {
    const h = harness({ signer: 1 })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    const other = h.addView('ta'), r2: any = { provider: 'claude', id: 'b5c3c5ee-0000-4000-8000-000000000002', sending: false, draft: null }
    other.form.children.unshift(Object.assign(new El('textarea', 'ta-input'), { parentNode: other.form }))
    h.paintWebKeyOffer(r2, other.opts); await flush()
    h.r.live = { working: true }; h.phoneBusyPaint(h.r)
    expect(h.form.querySelector('[data-phone-offer]')!.disabled).toBe(true)
    expect(other.form.querySelector('[data-phone-offer]')!.disabled).toBe(false)
    expect(other.form.querySelector('[data-phone-busy]')).toBeNull()
  })
  it('the caution box continues the send that asked it: the phone path on the phone, the plain Send plain (reader and Today)', () => {
    expect(APP).toContain("if (act === 'caution-send' && rd) { rd.cautionAck = true; rd.cautionAsk = false; renderVerdict(rd); if (rd.cautionVia === 'phone') { rd.cautionVia = null; return approveOnPhone(); } return sendSessionTurn(false); }")
    expect(APP).toContain("if (act === 'caution-cancel' && rd) { rd.cautionAsk = false; rd.cautionVia = null; renderVerdict(rd); return; }")
    expect(APP).toContain("r.cautionAsk = true; r.cautionVia = 'plain'; renderVerdict(r); return; }")
    const TA = readFileSync(join(HERE, 'panes', 'today-actions.js'), 'utf8')
    expect(TA).toContain("if (O.cautionVia === 'phone' && O.r && K.approvePhone) { O.cautionVia = null; return K.approvePhone(phoneApprovalOptions(O.r)); }")
    expect(TA).toContain("O.cautionAsk = true; O.cautionVia = 'plain'; O.armedAt = { caution: Date.now() }; paintVerdict(); return; }")
    expect(TA).toContain("askCaution: function () { if (O.r !== r) return; O.cautionAsk = true; O.cautionVia = 'phone';")
    expect(TA).toContain("if (what === 'caution-cancel') { O.cautionAsk = false; O.cautionVia = null; return paintVerdict(); }")
  })
  it('F1 08:0x: with a request card up, the reader\'s own placeholder logic says Add a note; the beside title keeps its gaps; Send as message only comes first', async () => {
    // The reader's placeholder painter (app.js, at the Mac's prompt) yields to the card.
    expect(APP).toContain("var phNote = typeof phoneBoxPlaceholder === 'function' ? phoneBoxPlaceholder() : '';")
    expect(APP).toContain("if (phNote) { box.phLong = phNote; box.phShort = ''; }")
    expect(APP.indexOf("if (phNote) { box.phLong = phNote; box.phShort = ''; }")).toBeGreaterThan(APP.indexOf("box.phShort = open && !te ? 'Message (not an answer)' : '';"))
    const h = harness({ signer: 1, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    expect((h.input as any).phLong).toBe('Add a note')
    h.pageShow(); await flush()                  // revoked or re-read: the reader's own words come back
    const CSS = readFileSync(join(HERE, 'panes', 'cos-chat.css'), 'utf8')
    expect(CSS).toContain('#session-reader.pa-beside .pa-card .pa-title { white-space: normal; flex-wrap: wrap; column-gap: 5px; }')
    expect(CSS).not.toMatch(/pa-beside \.pa-card \.pa-title \{[^}]*display: block/)
    expect(CSS).toContain('.composer.pa-on .composer-actions [data-action="fork-session"] { order: 1; }')
  })
  // Q1 08:29 (C3, C4): the reader's placeholder is 7.0.50's words unless a request card is up; "Add a note" only then,
  // and the reader's own words come back when the card goes.
  for (const [name, opts] of [
    ['approvals off', { signer: 0, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] }],
    ['no enrolled key', { signer: 1, activeKeys: 0, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] }],
    ['a key but no request', { signer: 1, packets: [] }],
    ['off the ts.net name', { signer: 1, hostname: '192.168.1.20', packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] }],
  ] as const) {
    it(`Q1 C3: ${name}: the reader keeps its own placeholder words (phoneBoxPlaceholder is empty, phLong untouched)`, async () => {
      const h = harness(opts as any)
      ;(h.input as any).phLong = 'Continue this session…'; (h.input as any).phShort = ''
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      expect(h.phoneBoxPlaceholder()).toBe('')
      expect((h.input as any).phLong).toBe('Continue this session…')
      expect(h.input.getAttribute('placeholder')).toBe('Continue this session…')
    })
  }
  it('Q1 C3: with a request card up, phoneBoxPlaceholder says Add a note', async () => {
    const h = harness({ signer: 1, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    expect(h.phoneBoxPlaceholder()).toBe('Add a note')
  })
  it('Q1 C4: when the card goes (key revoked), the reader\'s own words come back: phLong, the placeholder and phoneBoxPlaceholder', async () => {
    const opts: any = { signer: 1, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] }
    const h = harness(opts)
    ;(h.input as any).phLong = 'Continue this session…'
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    expect((h.input as any).phLong).toBe('Add a note')
    opts.activeKeys = 0
    h.pageShow(); await flush()
    expect((h.input as any).phLong).toBe('Continue this session…')
    expect(h.input.getAttribute('placeholder')).toBe('Continue this session…')
    expect(h.phoneBoxPlaceholder()).toBe('')
  })
  it('the reader repaints the phone action when working changes: one call, in sxSettle, after the flag is set', () => {
    const settle = APP.slice(APP.indexOf('  function sxSettle(r) {'), APP.indexOf('  function sxNoteGate(r, busy)'))
    expect(settle.split('phoneBusyPaint(r)').length - 1).toBe(1)
    expect(settle.indexOf('r.live.working = working;')).toBeLessThan(settle.indexOf('phoneBusyPaint(r)'))
    expect(settle).toContain("if (was !== working && typeof phoneBusyPaint === 'function') phoneBusyPaint(r);")
    expect(APP.split('phoneBusyPaint(').length - 1).toBe(2)   // the definition and that one call
  })
  it('a reader at least 560 px wide puts the request beside the conversation; a narrower one keeps it above the words', async () => {
    for (const [w, beside] of [[560, true], [1000, true], [559, false], [470, false]] as const) {
      const h = harness({ signer: 1, packets: PK(), readerWidth: w })
      h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
      const c = (h.form as any).__paCard
      expect(h.reader.classList.contains('pa-beside')).toBe(beside)
      expect(c.parentNode === h.body).toBe(beside)
      expect(c.parentNode === h.chat).toBe(!beside)
    }
  })
})

describe('7.0.53: the phone trip from the COS thread\'s Answer box (W1; X1: from: "thread", back to #/messages/cos)', () => {
  const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
  const trip = (over: Record<string, unknown> = {}) => ({ v: 1, provider: 'claude', id: SID, key: 'ct-key-trip01', bindingId: 'b-1', text: 'Ship it.', at: Date.now(), ...over })
  const thread = (item: unknown = 'fi_42', top: unknown = 212.4) => ({ from: 'thread', thread: () => ({ item, top }) })
  it('the box\'s primary is routed by the thread\'s own delegate (data-cos="rr-phone"), never the reader\'s or Today\'s', async () => {
    const h = harness({ signer: 1, prefix: 'rr', text: 'Ship it.' })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    const go = h.form.querySelector('[data-phone-offer]')!
    expect(go.getAttribute('data-cos')).toBe('rr-phone')
    expect(go.getAttribute('data-action')).toBeNull()
    expect(go.getAttribute('data-ta')).toBeNull()
    expect(h.send.textContent).toBe('Send')   // 7.0.56: the plain send, the Answer box's primary (no request card up)
    expect(h.send.nextSibling).toBe(go)       // and the passkey send just after it, the secondary
    for (const [prefix, attr, value] of [['session', 'data-action', 'approve-on-phone'], ['ta', 'data-ta', 'approve-phone']] as const) {
      const o = harness({ signer: 1, prefix, text: 'x' }); o.paintWebKeyOffer(o.r, o.viewOpts); await flush()
      expect(o.form.querySelector('[data-phone-offer]')!.getAttribute(attr)).toBe(value)
    }
  })
  it('from the thread, the record says so, with the row\'s newest item and its height (rounded); nothing else is added', async () => {
    const h = harness({ signer: 1, prefix: 'rr', text: 'Ship it.' })
    expect(await h.approveOnPhone({ ...h.viewOpts, ...thread() })).toBe('opened')
    const rec = JSON.parse(h.store.get('cos.phoneTrip')!)
    expect(Object.keys(rec).sort()).toEqual(['at', 'bindingId', 'from', 'id', 'item', 'key', 'provider', 'text', 'top', 'v'])
    expect(rec).toMatchObject({ from: 'thread', item: 'fi_42', top: 212, text: 'Ship it.' })
  })
  it('an item that is not a feed id, or no row at all: a plain record, exactly as before', async () => {
    for (const t of [thread('<img>'), thread(''), { from: 'thread', thread: () => null }, { from: 'elsewhere', thread: () => ({ item: 'fi_1', top: 1 }) }]) {
      const h = harness({ signer: 1, prefix: 'rr', text: 'Ship it.' })
      expect(await h.approveOnPhone({ ...h.viewOpts, ...t })).toBe('opened')
      expect(Object.keys(JSON.parse(h.store.get('cos.phoneTrip')!)).sort()).toEqual(['at', 'bindingId', 'id', 'key', 'provider', 'text', 'v'])
    }
    // A height that is not a number is kept as unknown (null), never as text.
    const h = harness({ signer: 1, prefix: 'rr', text: 'Ship it.' })
    await h.approveOnPhone({ ...h.viewOpts, ...thread('fi_7', 'x') })
    expect(JSON.parse(h.store.get('cos.phoneTrip')!)).toMatchObject({ from: 'thread', item: 'fi_7', top: null })
  })
  it('a #/phone-return load with a thread record goes back to the COS thread; a record without from still opens its session', () => {
    expect(harness({ signer: 1, hash: '#/phone-return', trip: trip({ from: 'thread', item: 'fi_42', top: 212 }) }).replaced).toEqual(['/control/#/messages/cos'])
    expect(harness({ signer: 1, hash: '#/phone-return', trip: trip({ from: 'thread', item: 'fi_42', top: null }) }).replaced).toEqual(['/control/#/messages/cos'])
    expect(harness({ signer: 1, hash: '#/phone-return', trip: trip() }).replaced).toEqual(['/control/#/sessions/claude/' + SID])
  })
  it('a record this page did not write (another from, a bad item, a text height) is dropped: Today, as for a broken one', () => {
    for (const bad of [{ from: 'reader', item: 'fi_1', top: 1 }, { from: 'thread', item: 'a b', top: 1 }, { from: 'thread', top: 1 }, { from: 'thread', item: 'fi_1', top: '9' }]) {
      const h = harness({ signer: 1, hash: '#/phone-return', trip: trip(bad) })
      expect(h.replaced, JSON.stringify(bad)).toEqual(['/control/#/today'])
      expect(h.store.size).toBe(0)
    }
  })
  it('a caller\'s fresh precheck (the box asks whether an approval now waits): its no stops the trip before anything is asked or opened; its yes goes on', async () => {
    const no = harness({ signer: 1, prefix: 'rr', text: 'Ship it.' })
    let asked = 0
    expect(await no.approveOnPhone({ ...no.viewOpts, ...thread(), precheck: () => { asked++; return Promise.resolve(false) } })).toBe('checked')
    expect(asked).toBe(1)
    expect(no.requests.filter(q => q.path === '/api/web-key/handoff' || q.path.endsWith('/attach'))).toEqual([])
    expect(no.assigned).toEqual([])
    expect(no.store.size).toBe(0)
    expect(no.r.sending).toBe(false)
    const yes = harness({ signer: 1, prefix: 'rr', text: 'Ship it.' })
    expect(await yes.approveOnPhone({ ...yes.viewOpts, ...thread(), precheck: () => Promise.resolve(true) })).toBe('opened')
    expect(yes.assigned).toHaveLength(1)
    // A failed check is a no.
    const err = harness({ signer: 1, prefix: 'rr', text: 'Ship it.' })
    expect(await err.approveOnPhone({ ...err.viewOpts, precheck: () => Promise.reject(new Error('x')) })).toBe('checked')
    expect(err.assigned).toEqual([])
  })
  it('X1 01:0x: the thread never reads, shows or carries an install or publish request, even with one live for the session', async () => {
    const live = [{ packet: PACKET, packetSha256: 'b'.repeat(64) }]
    // The reader on the same session gets the card (the control: the packet is live and valid).
    const reader = harness({ signer: 1, packets: live, text: '' })
    reader.paintWebKeyOffer(reader.r, reader.viewOpts); await flush()
    expect(reader.requests.some(q => q.path.startsWith('/api/web-key/packets?'))).toBe(true)
    expect([...reader.chat.children].some((c: any) => c.attrs['data-phone-card'] === '1')).toBe(true)
    // The thread's box: no read of the requests, no card, no "Approve" label.
    const h = harness({ signer: 1, prefix: 'rr', packets: live, text: '' })
    const opts = { ...h.viewOpts, ...thread() }
    h.paintWebKeyOffer(h.r, opts); await flush()
    expect(h.requests.some(q => q.path.startsWith('/api/web-key/packets?'))).toBe(false)
    expect([...h.chat.children].some((c: any) => c.attrs['data-phone-card'] === '1')).toBe(false)
    expect((h.form as any).__paCard).toBeFalsy()
    const go = h.form.querySelector('[data-phone-offer]')!
    expect(go.innerHTML).not.toContain('Approve')
    // An empty box is a message with no words, never "Approve install X".
    expect(await h.approveOnPhone(opts)).toBe('empty')
    expect(h.statuses).toContainEqual(['Write a message first.', 'error'])
    // A request loaded for this session elsewhere is never carried from the thread.
    h.r.phonePacketSha256 = 'b'.repeat(64); h.r.phonePackets = { ['b'.repeat(64)]: PACKET }
    h.input.value = 'Ship it.'
    expect(await h.approveOnPhone(opts)).toBe('opened')
    const handoff = h.requests.filter(q => q.path === '/api/web-key/handoff')
    expect(handoff).toHaveLength(1)
    expect(handoff[0]!.body).not.toHaveProperty('packetSha256')
    expect(handoff[0]!.body.prompt).toBe('Ship it.')
  })
  it('a thread record comes back only into the thread\'s box, and a reader record only into the reader\'s', async () => {
    const h = harness({ hash: '#/phone-return', signer: 1, prefix: 'rr', text: '', trip: trip({ from: 'thread', item: 'fi_42', top: 10 }) })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    expect(h.input.value).toBe('')
    expect(h.store.size).toBe(1)
    h.paintWebKeyOffer(h.r, { ...h.viewOpts, from: 'thread' }); await flush()
    expect(h.input.value).toBe('Ship it.')
    expect(h.plainKey()).toBe('ct-key-trip01')
    expect(h.store.size).toBe(0)
    const s = harness({ hash: '#/phone-return', signer: 1, prefix: 'rr', text: '', trip: trip() })
    s.paintWebKeyOffer(s.r, { ...s.viewOpts, from: 'thread' }); await flush()
    expect(s.input.value).toBe('')
    expect(s.store.size).toBe(1)
  })
})
