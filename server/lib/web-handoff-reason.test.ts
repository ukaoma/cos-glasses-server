/**
 * Why a sign-in link failed (S1 item 7, lead 2026-11-09 20:11). WebHandoffStore says expired, used, evicted or unknown;
 * the login route logs it as `sub=` and the person sees the same sentence as before for all four. Single use and the
 * 2-minute life are unchanged. A retired ticket is remembered only as a SHA-256, for an hour, at most 256 of them.
 */
import { describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { WebDeviceCodeStore, WebHandoffStore, WebLoginLimiter, WEB_HANDOFF_MAX_ACTIVE, WEB_HANDOFF_RETIRED_MAX, WEB_HANDOFF_RETIRED_MS, WEB_HANDOFF_TTL_MS, classifyWebLogin } from './web-session-auth.js'
import { requireApiToken } from './api-auth.js'
import { createWebControlRouter, WEB_LOGIN_FAILURE_MESSAGE } from '../routes/web-control.js'

const TOKEN = 'handoff-reason-token-0123456789abcdef'
function clock(start = Date.parse('2026-11-10T12:00:00.000Z')) { let t = start; return { now: () => t, add: (ms: number) => { t += ms } } }

describe('WebHandoffStore: why a ticket did not sign in', () => {
  it('a good ticket signs in once; the second use is "used"', () => {
    const c = clock(), s = new WebHandoffStore(c.now)
    const { ticket } = s.mint()
    expect(s.consumeWithReason(ticket)).toEqual({ ok: true })
    expect(s.consumeWithReason(ticket)).toEqual({ ok: false, why: 'used' })
    expect(s.consume(ticket)).toBe(false)
  })
  it('past its 2 minutes it is "expired", whether or not a sweep removed it first', () => {
    const c = clock(), s = new WebHandoffStore(c.now)
    const a = s.mint().ticket
    c.add(WEB_HANDOFF_TTL_MS)
    expect(s.consumeWithReason(a)).toEqual({ ok: false, why: 'expired' })
    const b = s.mint().ticket
    c.add(WEB_HANDOFF_TTL_MS + 1)
    s.mint()                                                       // a mint sweeps the expired one out first
    expect(s.consumeWithReason(b)).toEqual({ ok: false, why: 'expired' })
  })
  it('pushed out by more than 16 open tickets: "evicted"', () => {
    const c = clock(), s = new WebHandoffStore(c.now)
    const first = s.mint().ticket
    for (let i = 0; i < WEB_HANDOFF_MAX_ACTIVE; i++) s.mint()
    expect(s.consumeWithReason(first)).toEqual({ ok: false, why: 'evicted' })
  })
  it('never issued here, or issued before this server started: "unknown"', () => {
    const c = clock(), before = new WebHandoffStore(c.now)
    const ticket = before.mint().ticket
    const restarted = new WebHandoffStore(c.now)
    expect(restarted.consumeWithReason(ticket)).toEqual({ ok: false, why: 'unknown' })
    expect(restarted.consumeWithReason('not a ticket')).toEqual({ ok: false, why: 'unknown' })
  })
  it('remembers why for an hour, then says unknown; and at most 256 retired tickets', () => {
    const c = clock(), s = new WebHandoffStore(c.now)
    const t = s.mint().ticket
    s.consume(t)
    c.add(WEB_HANDOFF_RETIRED_MS - 1)
    expect(s.consumeWithReason(t).ok === false && (s.consumeWithReason(t) as { why: string }).why).toBe('used')
    c.add(1)
    expect(s.consumeWithReason(t)).toEqual({ ok: false, why: 'unknown' })
    const s2 = new WebHandoffStore(c.now)
    const oldest = s2.mint().ticket; s2.consume(oldest)
    for (let i = 0; i < WEB_HANDOFF_RETIRED_MAX; i++) { const x = s2.mint().ticket; s2.consume(x) }
    expect(s2.consumeWithReason(oldest), 'the oldest of 257 retired tickets is forgotten').toEqual({ ok: false, why: 'unknown' })
  })
  it('classifyWebLogin carries the reason; the reason word stays handoff_expired', () => {
    const c = clock(), s = new WebHandoffStore(c.now)
    const t = s.mint().ticket
    s.consume(t)
    expect(classifyWebLogin({ handoff: t }, TOKEN, s)).toEqual({ ok: false, reason: 'handoff_expired', length: t.length, handoff: 'used' })
  })
})

describe('the login route logs the reason and tells the person the same thing as before', () => {
  async function withLogin(store: WebHandoffStore, fn: (port: number, lines: string[]) => Promise<void>, limiter?: WebLoginLimiter) {
    const app = express()
    let port = 0
    const lines: string[] = []
    app.use('/api', requireApiToken(TOKEN, { selfDnsName: () => null, allowedPorts: () => [port] }))
    app.use('/api', createWebControlRouter({ apiToken: () => TOKEN, port: () => port, selfDnsName: () => null, handoffStore: store, log: l => lines.push(l), ...(limiter ? { loginLimiter: limiter } : {}) }))
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    try { await fn(port, lines) } finally { await new Promise(resolve => server.close(resolve)) }
  }
  const login = (port: number, body: Record<string, string>) => fetch(`http://127.0.0.1:${port}/api/web-session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('used, expired and unknown links each log their sub-reason; the answer is the same 401 and sentence', async () => {
    const c = clock(Date.now()), store = new WebHandoffStore(c.now)
    await withLogin(store, async (port, lines) => {
      const used = store.mint().ticket
      expect((await login(port, { handoff: used })).status).toBe(200)
      const r = await login(port, { handoff: used })
      expect(r.status).toBe(401)
      expect(await r.json()).toMatchObject({ error: 'invalid_credentials', reason: 'handoff_expired', message: WEB_LOGIN_FAILURE_MESSAGE.handoff_expired })
      const old = store.mint().ticket
      c.add(WEB_HANDOFF_TTL_MS + 1)
      await login(port, { handoff: old })
      await login(port, { handoff: 'A'.repeat(32) })
      const fails = lines.filter(l => l.startsWith('[web-login] fail'))
      expect(fails.map(l => /sub=(\w+)/.exec(l)?.[1])).toEqual(['used', 'expired', 'unknown'])
      expect(fails.every(l => !l.includes(used) && !l.includes(old))).toBe(true)
    })
  })
})

// ── Miles 2026-11-09 20:00, "Yes, stop counting stale links" ──
describe('a failed sign-in link no longer counts toward the per-device lockout; a wrong code still does', () => {
  async function withLoginL(store: WebHandoffStore, limiter: WebLoginLimiter, fn: (port: number) => Promise<void>) {
    const app = express()
    let port = 0
    app.use('/api', requireApiToken(TOKEN, { selfDnsName: () => null, allowedPorts: () => [port] }))
    app.use('/api', createWebControlRouter({ apiToken: () => TOKEN, port: () => port, selfDnsName: () => null, handoffStore: store, loginLimiter: limiter, log: () => {} }))
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    try { await fn(port) } finally { await new Promise(resolve => server.close(resolve)) }
  }
  const login = (port: number, body: Record<string, string>) => fetch(`http://127.0.0.1:${port}/api/web-session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('ten each of used, expired, evicted and unknown links: never locked out, and the token still signs in', async () => {
    const c = clock(Date.now()), store = new WebHandoffStore(c.now), limiter = new WebLoginLimiter()
    await withLoginL(store, limiter, async port => {
      for (let i = 0; i < 10; i++) {
        // Used up in the store, not by a sign-in here: a successful sign-in resets the count and would hide a regression.
        const used = store.mint().ticket; store.consume(used)
        expect((await login(port, { handoff: used })).status, 'used').toBe(401)
        const old = store.mint().ticket; c.add(WEB_HANDOFF_TTL_MS + 1)
        expect((await login(port, { handoff: old })).status, 'expired').toBe(401)
        const evicted = store.mint().ticket
        for (let k = 0; k < WEB_HANDOFF_MAX_ACTIVE; k++) store.mint()
        expect((await login(port, { handoff: evicted })).status, 'evicted').toBe(401)
        expect((await login(port, { handoff: 'B'.repeat(32) })).status, 'unknown').toBe(401)
      }
      expect(limiter.blockedFor('127.0.0.1'), '40 failed links in a row, no success between them').toBe(0)
      expect((await login(port, { token: TOKEN })).status).toBe(200)
    })
  })
  it('wrong typed codes still count: the 9th try is refused 429, even with a good link', async () => {
    const store = new WebHandoffStore(), limiter = new WebLoginLimiter()
    await withLoginL(store, limiter, async port => {
      for (let i = 0; i < 8; i++) expect((await login(port, { code: 'K7P3-QX9M' })).status).toBe(401)
      expect((await login(port, { code: 'K7P3-QX9M' })).status).toBe(429)
      expect((await login(port, { handoff: store.mint().ticket })).status, 'the lockout check itself is unchanged').toBe(429)
    })
  })
})

// ── Final review V7 (lead 2026-11-10 02:18): Sign out every browser also ends links and codes made before it ──
describe('Sign out every browser also ends the sign-in links and codes made before it (final review V7)', () => {
  async function withRevoke(fn: (port: number, stores: { links: WebHandoffStore; codes: WebDeviceCodeStore }, lines: string[]) => Promise<void>) {
    const app = express()
    let port = 0
    const lines: string[] = []
    const links = new WebHandoffStore(), codes = new WebDeviceCodeStore()
    app.use('/api', requireApiToken(TOKEN, { selfDnsName: () => null, allowedPorts: () => [port] }))
    app.use('/api', createWebControlRouter({ apiToken: () => TOKEN, port: () => port, selfDnsName: () => null, handoffStore: links, deviceCodeStore: codes, loginLimiter: new WebLoginLimiter(), log: l => lines.push(l) }))
    const server: Server = await new Promise(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)) })
    port = (server.address() as { port: number }).port
    try { await fn(port, { links, codes }, lines) } finally { await new Promise(resolve => server.close(resolve)) }
  }
  const post = (port: number, path: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const asMac = { 'X-COS-Token': TOKEN }

  it('a link and a code made before are refused after it; a code made after it works; the caller\'s cookie is still cleared', async () => {
    await withRevoke(async (port, { links }) => {
      const link = links.mint().ticket
      const before = await (await post(port, '/web-session/device-code', {}, asMac)).json() as { code: string }
      const r = await post(port, '/web-session/revoke-all', {}, asMac)
      expect(r.status).toBe(200)
      expect(r.headers.get('set-cookie') ?? '', 'the caller\'s own cookie is cleared').toMatch(/cos_web_session=;.*Max-Age=0/)
      expect((await post(port, '/web-session/login', { handoff: link })).status, 'link made before: refused').toBe(401)
      expect((await post(port, '/web-session/login', { code: before.code })).status, 'code made before: refused').toBe(401)
      const after = await (await post(port, '/web-session/device-code', {}, asMac)).json() as { code: string }
      expect((await post(port, '/web-session/login', { code: after.code })).status, 'code made after: works').toBe(200)
      const linkAfter = links.mint().ticket
      expect((await post(port, '/web-session/login', { handoff: linkAfter })).status, 'link made after: works').toBe(200)
    })
  })
  it('the server log says a refused link was revoked, never the link', async () => {
    await withRevoke(async (port, { links }, lines) => {
      const link = links.mint().ticket
      await post(port, '/web-session/revoke-all', {}, asMac)
      await post(port, '/web-session/login', { handoff: link })
      const fail = lines.find(l => l.startsWith('[web-login] fail')) ?? ''
      expect(fail).toContain('sub=revoked')
      expect(fail).not.toContain(link)
    })
  })
  it('the stores on their own: revokeAll ends every live link and code and says how many', () => {
    const c = clock(), links = new WebHandoffStore(c.now), codes = new WebDeviceCodeStore(c.now)
    const a = links.mint().ticket, b = links.mint().ticket
    const code = codes.mint().code
    expect(links.revokeAll()).toBe(2)
    expect(codes.revokeAll()).toBe(1)
    expect(links.consumeWithReason(a)).toEqual({ ok: false, why: 'revoked' })
    expect(links.consumeWithReason(b)).toEqual({ ok: false, why: 'revoked' })
    expect(codes.consume(code)).toBe(false)
    expect(links.revokeAll()).toBe(0)
  })
})
