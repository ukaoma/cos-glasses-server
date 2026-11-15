import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
const REGION = APP.slice(APP.indexOf('  var codeTimer = null;'), APP.indexOf('  // ── Ask sheet'))
const HTTP = 'http://mac.example.ts.net:3141/control'
const HTTPS = 'https://mac.example.ts.net:3142/control'
function harness(origin = 'http://localhost:3141') {
  const pending: Array<{ path: string; resolve: (v: any) => void; reject: (e: Error) => void }> = []
  const qr: string[] = [], copies: string[] = [], toasts: string[] = [], listeners: Record<string, (e: any) => void> = {}
  const panel = () => ({ innerHTML: '', classList: { remove() {} } })
  let currentPanel = panel(), clock = Date.UTC(2026, 10, 15, 21), serial = 0
  const address = { textContent: '' }, countdown = { textContent: '' }, timers = new Map<number, () => void>()
  const state = { tailnetUrl: '', pane: 'settings' }
  const location = new URL(origin)
  class FakeDate extends Date { static now() { return clock } }
  const ctx = vm.createContext({ state, location, URL, Date: FakeDate, Promise, Math, encodeURIComponent,
    window: { COSQR: { matrix(text: string) { qr.push(text); return { size: 1, data: [1] } } } },
    navigator: { clipboard: { writeText(text: string) { copies.push(text); return Promise.resolve() } } },
    document: { addEventListener(name: string, fn: (e: any) => void) { listeners[name] = fn } },
    $: (id: string) => id === 'device-code-panel' ? currentPanel : id === 'tailnet-url' ? address : id === 'device-code-left' && currentPanel.innerHTML.includes('device-code-left') ? countdown : null,
    esc: (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!),
    toDate: (s: string) => { const d = new Date(s); return Number.isFinite(d.getTime()) ? d : null },
    api: (path: string) => new Promise((resolve, reject) => pending.push({ path, resolve, reject })), toast: (s: string) => toasts.push(s),
    copyText(text: string) { copies.push(text); return Promise.resolve() },
    setInterval(fn: () => void) { timers.set(++serial, fn); return serial }, clearInterval(id: number) { timers.delete(id) },
  })
  vm.runInContext(REGION + ';this.h={load:loadTailnetUrl,show:showDeviceCode,copy:copyPhoneLink,paint:paintDeviceCode,select:recommendedPhoneUrl};', ctx)
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const req = (path: string, at = 0) => pending.filter(p => p.path === path)[at]!
  const code = (name = 'ABCD-1234', seconds = 300) => ({ code: name, expiresAt: new Date(clock + seconds * 1000).toISOString() })
  const url = (phoneUrl = HTTPS) => ({ phoneUrl, magicDnsUrl: HTTP, magicDnsHttpsUrl: HTTPS })
  return { ...ctx.h, ctx, state, address, countdown, qr, copies, toasts, timers, pending, req, code, url, flush,
    html: () => currentPanel.innerHTML, replace: () => { currentPanel = panel() }, advance: (ms: number) => { clock += ms; timers.forEach(fn => fn()) },
    refresh: () => listeners.click!({ target: { closest: () => ({}) } }),
  }
}
const GET = '/api/tailscale/web-url', CODE = '/api/web-session/device-code'

describe('one recommended phone address for Settings, QR and Copy', () => {
  it('uses the server canonical recommendation, including its explicit HTTP fallback', () => {
    const h = harness()
    expect(h.select(h.url())).toBe(HTTPS)
    expect(h.select(h.url(HTTP))).toBe(HTTP)
    expect(h.select({ magicDnsUrl: HTTP, ipv4Url: 'http://100.1.2.3:3141/control', magicDnsHttpsUrl: HTTPS })).toBe(HTTP)
    expect(h.select({ ipv4Url: 'http://100.1.2.3:3141/control' })).toBe('http://100.1.2.3:3141/control')
    expect(h.select({})).toBe('')
  })
  it('keeps the already-used HTTPS origin when an old server recommends HTTP on the same host', () => {
    const h = harness('https://mac.example.ts.net:3142')
    expect(h.select({ magicDnsUrl: HTTP })).toBe(HTTPS)
    expect(h.select({ magicDnsUrl: 'http://other.example.ts.net:3141/control' })).toBe('http://other.example.ts.net:3141/control')
  })
  it('waits for the asynchronous address before encoding a fast code, then displays the same URL', async () => {
    const h = harness(); const showing = h.show()
    h.req(CODE).resolve(h.code()); await h.flush()
    expect(h.html()).toBe('<p>Getting a code</p>'); expect(h.qr).toEqual([])
    h.req(GET).resolve(h.url()); await showing
    expect(h.qr).toEqual([HTTPS + '?code=ABCD-1234'])
    expect(h.html()).toContain(HTTPS); expect(h.address.textContent).toBe(HTTPS)
    expect(h.timers.size).toBe(1)
  })
  it('re-encodes a displayed QR and its address when configuration changes, retaining code and expiry', async () => {
    const h = harness(); const showing = h.show()
    h.req(GET).resolve(h.url(HTTP)); h.req(CODE).resolve(h.code()); await showing
    h.advance(60_000); h.refresh(); h.req(GET, 1).resolve(h.url()); await h.flush()
    expect(h.qr).toEqual([HTTP + '?code=ABCD-1234', HTTPS + '?code=ABCD-1234'])
    expect(h.html()).toContain(HTTPS); expect(h.html()).not.toContain(HTTP + '<')
    expect(h.countdown.textContent).toContain('4 more min'); expect(h.address.textContent).toBe(HTTPS)
    h.advance(240_000); expect(h.html()).toContain('That code expired'); expect(h.timers.size).toBe(0)
  })
  it('never revives an expired code when an address refresh lands', async () => {
    const h = harness(); const showing = h.show()
    h.req(GET).resolve(h.url()); h.req(CODE).resolve(h.code('ABCD-1234', 1)); await showing
    const refresh = h.load(true); h.advance(1000); h.req(GET, 1).resolve(h.url(HTTP)); await refresh
    expect(h.html()).toContain('That code expired'); expect(h.qr).toHaveLength(1); expect(h.timers.size).toBe(0)
  })
  it('does not briefly encode a code already expired while the address was loading', async () => {
    const h = harness(); const showing = h.show()
    h.req(CODE).resolve(h.code('ABCD-1234', 1)); h.advance(1000); h.req(GET).resolve(h.url()); await showing
    expect(h.html()).toContain('That code expired'); expect(h.qr).toEqual([]); expect(h.timers.size).toBe(0)
  })
  it('ignores an older HTTP response and gives its waiting QR the newest HTTPS recommendation', async () => {
    const h = harness(); const showing = h.show(); h.req(CODE).resolve(h.code())
    const refresh = h.load(true); h.req(GET, 1).resolve(h.url()); await refresh
    h.req(GET).resolve(h.url(HTTP)); await showing
    expect(h.state.tailnetUrl).toBe(HTTPS); expect(h.qr).toEqual([HTTPS + '?code=ABCD-1234']); expect(h.address.textContent).toBe(HTTPS)
  })
  it('an older failure cannot overwrite the newest address, and an unavailable refresh keeps it', async () => {
    const h = harness(); const first = h.load(true), second = h.load(true)
    h.req(GET, 1).resolve(h.url()); await second; h.req(GET).reject(new Error('offline')); await first
    expect(h.address.textContent).toBe(HTTPS)
    const failing = h.load(true); h.req(GET, 2).reject(new Error('offline')); await failing
    expect(h.state.tailnetUrl).toBe(HTTPS); expect(h.address.textContent).toBe(HTTPS)
  })
  it('newest code wins even if the older code request arrives last', async () => {
    const h = harness(); const older = h.show(), newer = h.show()
    h.req(GET, 1).resolve(h.url()); h.req(CODE, 1).resolve(h.code('NEW2-CODE')); await newer
    h.req(GET).resolve(h.url(HTTP)); h.req(CODE).resolve(h.code('OLD1-CODE')); await older
    expect(h.qr).toEqual([HTTPS + '?code=NEW2-CODE']); expect(h.html()).not.toContain('OLD1-CODE'); expect(h.timers.size).toBe(1)
  })
  it('does not paint a code into a replacement Settings panel', async () => {
    const h = harness(); const showing = h.show(); h.replace()
    h.req(GET).resolve(h.url()); h.req(CODE).resolve(h.code()); await showing
    expect(h.html()).toBe(''); expect(h.qr).toEqual([]); expect(h.timers.size).toBe(0)
  })
  it('copies the refreshed canonical URL and updates the address at the same time', async () => {
    const h = harness(); h.state.tailnetUrl = HTTP
    const copying = h.copy(); expect(h.copies).toEqual([])
    h.req(GET).resolve(h.url()); await copying
    expect(h.copies).toEqual([HTTPS]); expect(h.address.textContent).toBe(HTTPS); expect(h.toasts).toEqual(['Link copied'])
  })
  it('retains local-origin fallback for old/unavailable address APIs', async () => {
    const h = harness('https://localhost:3142'); const copying = h.copy()
    h.req(GET).reject(new Error('older server')); await copying
    expect(h.copies).toEqual(['https://localhost:3142/control'])
  })
  it('starts a deferred clipboard write inside the tap, with the eventual recommended URL', async () => {
    const h = harness(); let contents: any, writes = 0
    h.ctx.window.Blob = Blob
    h.ctx.window.ClipboardItem = class { data: any; constructor(data: any) { this.data = data } }
    h.ctx.navigator.clipboard.write = async (items: any[]) => { writes++; contents = await items[0].data['text/plain'] }
    const copying = h.copy(); expect(writes).toBe(1); expect(contents).toBeUndefined()
    h.req(GET).resolve(h.url()); await copying
    expect(await contents.text()).toBe(HTTPS); expect(h.toasts).toEqual(['Link copied'])
  })
  it('shows the exact current URL if the clipboard refuses, without claiming it copied', async () => {
    const h = harness(); h.ctx.copyText = () => Promise.reject(new Error('denied'))
    const copying = h.copy(); h.req(GET).resolve(h.url()); await copying
    expect(h.toasts).toEqual([HTTPS])
  })
  it('uses the existing copy helper if a partial clipboard implementation throws synchronously', async () => {
    const h = harness(); h.ctx.window.Blob = Blob
    h.ctx.window.ClipboardItem = class { constructor() { throw new Error('unsupported') } }
    h.ctx.navigator.clipboard.write = () => { throw new Error('must not reach') }
    const copying = h.copy(); h.req(GET).resolve(h.url()); await copying
    expect(h.copies).toEqual([HTTPS]); expect(h.toasts).toEqual(['Link copied'])
  })
  it('coalesces ordinary lifecycle reads while allowing a deliberate refresh to supersede them', async () => {
    const h = harness(); const one = h.load(), two = h.load()
    expect(one).toBe(two); expect(h.pending).toHaveLength(1)
    h.req(GET).resolve(h.url()); await one; expect(h.timers.size).toBe(0)
  })
  it('refreshes on Settings entry, Refresh, and visibility resume without an idle poll', () => {
    expect(APP).toContain("if (r.pane === 'settings' && changedPane) loadTailnetUrl();")
    expect(APP).toContain("if (state.pane === 'settings') loadTailnetUrl(true);")
    expect(APP).toContain("if (t.id === 'copy-link') {\n      return copyPhoneLink();")
    expect(REGION.match(/setInterval\(/g)).toHaveLength(1)
  })
})
