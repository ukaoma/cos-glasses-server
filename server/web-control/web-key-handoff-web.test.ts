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
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }
const HOST = 'ukaoma-mac-studio.tail38457f.ts.net'

class El {
  children: El[] = []; attrs: Record<string, string> = {}; textContent = ''; title = ''; className = ''; type = ''; value = ''
  parentNode: El | null = null
  listeners: Record<string, () => void> = {}
  get firstChild() { return this.children[0] ?? null }
  appendChild(n: El) { n.parentNode = this; this.children.push(n) }
  addEventListener(k: string, fn: () => void) { this.listeners[k] = fn }
  constructor(readonly tag: string, readonly id = '') {}
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  querySelector(sel: string): El | null {
    const m = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(sel)
    const walk = (e: El): El | null => { for (const c of e.children) { if (m && (m[2] === undefined ? m[1] in c.attrs : c.attrs[m[1]] === m[2])) return c; const d = walk(c); if (d) return d } return null }
    return walk(this)
  }
  insertBefore(n: El, ref: El) { n.parentNode = this; this.children.splice(Math.max(0, this.children.indexOf(ref)), 0, n) }
}

function harness(opts: { signer: number; activeKeys?: number; files?: string; handoff?: (body: any) => { status: number; body: any } | Promise<{ status: number; body: any }>; text?: string; bound?: boolean; packets?: any[]; prefix?: 'session' | 'ta'; packetRead?: Promise<any> }) {
  const prefix = opts.prefix ?? 'session'
  const form = new El('form', prefix + '-form'), actions = new El('div'), send = new El('button', prefix + '-send'), input = new El('textarea', prefix + '-input')
  form.children.push(actions); actions.children.push(send); send.parentNode = actions
  input.value = opts.text ?? 'Yes, go ahead.  '
  const ids: Record<string, El> = { [prefix + '-form']: form, [prefix + '-send']: send, [prefix + '-input']: input }
  const requests: Array<{ path: string; body?: any }> = []
  const assigned: string[] = []
  const statuses: Array<[string, string | undefined]> = []
  const r: any = { provider: 'claude', id: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d', sending: false, draft: null as any }
  const state = { reading: r }
  const apiAnswer = (path: string, o: any = {}) => {
    requests.push({ path, body: o.body })
    if (path === '/api/web-key/status') return Promise.resolve({ status: 200, body: { ok: true, activeKeys: opts.activeKeys ?? 1 } })
    if (path.startsWith('/api/web-key/packets?')) return opts.packetRead ?? Promise.resolve({ status: 200, body: { ok: true, packets: opts.packets ?? [] } })
    if (path.endsWith('/attach')) return Promise.resolve({ status: 201, body: { attached: true, bindingId: 'b-1', epoch: 2 } })
    if (path === '/api/web-key/handoff') return Promise.resolve(opts.handoff ? opts.handoff(o.body) : { status: 201, body: { ok: true, handoffId: 'h'.repeat(24), signerUrl: `https://${HOST}:3144/#h=${'h'.repeat(24)}` } })
    return Promise.resolve({ status: 404, body: {} })
  }
  const fns = new Function(
    'readerKit', 'apiAnswer', 'state', '$', 'document', 'sessionStatus', 'readerFilesOn', 'readerBox', 'readerFilesState', 'draftFor', 'bindingFor', 'rememberBinding', 'sessionPath', 'cosSessionId', 'targetKey', 'location', 'URL', 'newTurnKey',
    BLOCK + '\nreturn { paintWebKeyOffer: paintWebKeyOffer, approveOnPhone: approveOnPhone, webKeySignerUrlOk: webKeySignerUrlOk };',
  )(
    () => ({ webKeySigner: () => opts.signer }), apiAnswer, state, (id: string) => ids[id] ?? null, { createElement: (t: string) => new El(t) },
    (t: string, k?: string) => statuses.push([t, k]), () => true, () => ({}), () => opts.files ?? 'none',
    (text: string, rr: any) => { rr.draft = rr.draft && rr.draft.text === text ? rr.draft : { text, key: 'ct-key-000001', ids: [] }; return rr.draft },
    () => (opts.bound === false ? null : { bindingId: 'b-1', epoch: 2 }), () => {}, (p: string, i: string, t: string) => `/api/agent-sessions/${p}/${i}${t}`, () => 'cos-1',
    (p: string, i: string) => `${p.length}:${p}:${i.length}:${i}`, { hostname: HOST, assign: (u: string) => assigned.push(u) }, URL, () => 'ct-key-000001',
  ) as { paintWebKeyOffer: (r: unknown, o?: unknown) => void; approveOnPhone: (o?: unknown) => Promise<string>; webKeySignerUrlOk: (u: string) => boolean }
  const liveView = { active: true }
  const viewOpts = { r, prefix, live: () => liveView.active, status: (t: string, k?: string) => statuses.push([t, k]), files: () => opts.files ?? 'none' }
  return { ...fns, r, state, form, input, requests, assigned, statuses, liveView, viewOpts }
}

describe('flag off: the composer is exactly as before', () => {
  it('no webKeySigner capability: no request and no button', async () => {
    const h = harness({ signer: 0 })
    h.paintWebKeyOffer(h.r)
    await flush()
    expect(h.requests).toEqual([])
    expect(h.form.querySelector('[data-action="approve-on-phone"]')).toBeNull()
  })
  it('the composer markup is the 6.99.29 markup, byte for byte', () => {
    const PINNED = `'<form class="composer att-composer" id="session-form" data-provider="' + esc(provider) + '" data-id="' + esc(id) + '">' +
            '<div class="cc-chips att-files hidden" id="session-files"></div>' +
            '<textarea id="session-input" rows="1" placeholder="Continue this session…" enterkeyhint="send" aria-label="Continue this session"></textarea>' +
            '<div class="composer-actions"><span id="session-clip" class="att-clip"></span><button type="button" class="btn small" data-action="fork-session" title="Copy this session and send the message to the copy">Fork</button>' +
            '<button type="submit" class="btn primary small" id="session-send">Send</button></div>' +
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
  it('adds "Approve on this phone" before Send, once', async () => {
    const h = harness({ signer: 1 })
    h.paintWebKeyOffer(h.r)
    h.paintWebKeyOffer(h.r)
    await flush()
    const b = h.form.querySelector('[data-action="approve-on-phone"]')
    expect(b?.textContent).toBe('Approve on this phone')
    expect(h.form.children[0].children.map(c => c.attrs['data-action'] ?? c.id)).toEqual(['approve-on-phone', 'session-send'])
    expect(h.requests.filter(q => q.path === '/api/web-key/status')).toHaveLength(1)
  })
  it('no enrolled key: no button', async () => {
    const h = harness({ signer: 1, activeKeys: 0 })
    h.paintWebKeyOffer(h.r)
    await flush()
    expect(h.form.querySelector('[data-action="approve-on-phone"]')).toBeNull()
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

const PACKET = { v: 'cos-web-packet/1', packetId: 'AAECAwQFBgcICQoL', action: 'publish', artifact: '@gotcos/glasses-server', version: '7.0.6', digest: 'sha256:' + 'a'.repeat(64), channel: 'npm-latest', provider: 'claude', sessionId: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d', createdAt: Date.now(), exp: Date.now() + 1800000 }
describe('explicit release packet selection', () => {
  it('lists only this receiving session, shows exact fields and sends the selected hash', async () => {
    const sha = 'b'.repeat(64)
    const h = harness({ signer: 1, text: '', packets: [{ packet: PACKET, packetSha256: sha }, { packet: { ...PACKET, sessionId: 'other' }, packetSha256: 'c'.repeat(64) }] })
    h.paintWebKeyOffer(h.r); await flush()
    const box = h.form.children.find(c => c.className === 'phone-approval-packet')!
    const select = box.children.find(c => c.tag === 'select')!
    expect(select.children).toHaveLength(2)
    select.value = sha; select.listeners.change()
    const details = box.children.find(c => c.tag === 'details')!.children.find(c => c.tag === 'pre')!.textContent
    for (const field of [PACKET.artifact, PACKET.version, PACKET.digest, PACKET.channel, PACKET.sessionId, sha]) expect(details).toContain(field)
    expect(h.input.value).toContain('Approve publish')
    expect(await h.approveOnPhone()).toBe('opened')
    expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body.packetSha256).toBe(sha)
  })
  it('a stale selected packet fails rather than silently falling back to message authority', async () => {
    const h = harness({ signer: 1 })
    h.r.phonePacketSha256 = 'd'.repeat(64); h.r.phonePackets = {}
    expect(await h.approveOnPhone()).toBe('packet')
    expect(h.requests).toEqual([])
    expect(h.assigned).toEqual([])
  })
  it('a normal note has no packet hash and remains message scope', async () => {
    const h = harness({ signer: 1, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] })
    h.paintWebKeyOffer(h.r); await flush()
    expect(await h.approveOnPhone()).toBe('opened')
    expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body).not.toHaveProperty('packetSha256')
  })
  it('Today-prefix picker sends an explicitly selected publish packet to the same bound receiver', async () => {
    const sha = 'b'.repeat(64), h = harness({ signer: 1, prefix: 'ta', text: '', packets: [{ packet: PACKET, packetSha256: sha }] })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    expect(h.form.querySelector('[data-ta="approve-phone"]')?.textContent).toBe('Approve on this phone')
    const select = h.form.children.find(c => c.className === 'phone-approval-packet')!.children.find(c => c.tag === 'select')!
    expect(select.id).toBe('ta-phone-packet')
    select.value = sha; select.listeners.change()
    expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
    expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body).toMatchObject({ packetSha256: sha, bindingId: 'b-1', targetKey: '6:claude:36:' + PACKET.sessionId })
  })
  it('Today-prefix ordinary note includes no approval packet, even when requests are available', async () => {
    const h = harness({ signer: 1, prefix: 'ta', packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    expect(await h.approveOnPhone(h.viewOpts)).toBe('opened')
    expect(h.requests.find(q => q.path === '/api/web-key/handoff')!.body).not.toHaveProperty('packetSha256')
  })
  it('Today-prefix late packet list cannot paint into a closed or replaced overlay', async () => {
    let finish!: (value: any) => void
    const h = harness({ signer: 1, prefix: 'ta', packetRead: new Promise(resolve => { finish = resolve }) })
    h.paintWebKeyOffer(h.r, h.viewOpts); await flush()
    h.liveView.active = false
    finish({ status: 200, body: { ok: true, packets: [{ packet: PACKET, packetSha256: 'b'.repeat(64) }] } }); await flush()
    expect(h.form.children.find(c => c.className === 'phone-approval-packet')).toBeUndefined()
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
