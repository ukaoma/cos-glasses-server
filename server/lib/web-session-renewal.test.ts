/**
 * Control Web sign-in renewal (Miles 2026-11-09, "Renew while in use, 30-day cap"). lib/web-session-auth.ts and the /api
 * gate (lib/api-auth.ts). A browser used in the last 2 days of its cookie gets a fresh one, never past 30 days from its
 * first sign-in. Old 3-part cookies keep working for their own 7 days and count as signed in at their issue time.
 * "Sign out every browser" (epoch) and a pairing-token change still end every renewed cookie.
 */
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bumpWebSessionEpoch, currentWebSessionEpoch, mintWebSessionCookieValue, readWebSessionCookie, renewWebSessionCookieValue,
  setWebSessionEpochFile, verifyWebSessionCookieValue, WEB_SESSION_COOKIE_NAME, WEB_SESSION_MAX_LIFE_MS, WEB_SESSION_RENEW_WINDOW_MS,
  WEB_SESSION_TTL_MS,
} from './web-session-auth.js'
import { requireApiToken, WEB_SESSION_RENEWED_HEADER } from './api-auth.js'

const TOKEN = 'renewal-test-token-0123456789abcdef'
const S = 1000, D = 24 * 3600 * S
const NOW = Date.parse('2026-11-10T12:00:00.000Z')
const sec = (ms: number) => Math.floor(ms / 1000)
// The renewed cookie's signature, computed here from its documented recipe so a forged-but-signed cookie can be built.
const signV3 = (exp: number, epoch: number, orig: number, token = TOKEN) =>
  createHmac('sha256', `cos_web_session_v2:${token}`).update(`v3:${exp}:${epoch}:${orig}`).digest('hex')
const sign3 = (exp: number, epoch: number, token = TOKEN) => createHmac('sha256', `cos_web_session_v2:${token}`).update(`${exp}:${epoch}`).digest('hex')

afterEach(() => setWebSessionEpochFile(null))

describe('renewWebSessionCookieValue: when a cookie renews', () => {
  it('a fresh sign-in does not renew; the last 2 days do', () => {
    const fresh = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    expect(renewWebSessionCookieValue(fresh.value, TOKEN, NOW, 0)).toBeNull()
    const late = NOW + WEB_SESSION_TTL_MS - WEB_SESSION_RENEW_WINDOW_MS + S       // 2 days less 1 s left
    const r = renewWebSessionCookieValue(fresh.value, TOKEN, late, 0)!
    expect(r).not.toBeNull()
    expect(r.expiresAtMs).toBe(sec(late + WEB_SESSION_TTL_MS) * 1000)
    expect(r.value.split('.')).toHaveLength(4)
    expect(readWebSessionCookie(r.value, TOKEN, late, 0)).toEqual({ expUnixSec: sec(late + WEB_SESSION_TTL_MS), origUnixSec: sec(NOW), renewed: true })
  })
  it('window edges: exactly 2 days left renews, 2 days and 1 s left does not', () => {
    const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    const exp = sec(c.expiresAtMs) * 1000
    expect(renewWebSessionCookieValue(c.value, TOKEN, exp - WEB_SESSION_RENEW_WINDOW_MS, 0)).not.toBeNull()
    expect(renewWebSessionCookieValue(c.value, TOKEN, exp - WEB_SESSION_RENEW_WINDOW_MS - S, 0)).toBeNull()
  })
  it('never past 30 days from the first sign-in: the last renewal stops at the cap, and none after it', () => {
    const orig = sec(NOW), cap = orig + sec(WEB_SESSION_MAX_LIFE_MS)
    const at = (cap - sec(3 * D)) * 1000                                   // 3 days before the cap, 1 day left on the cookie
    const exp = sec(at) + sec(D)
    const c = `${exp}.0.${orig}.${signV3(exp, 0, orig)}`
    const r = renewWebSessionCookieValue(c, TOKEN, at, 0)!
    expect(r.expiresAtMs).toBe(cap * 1000)
    expect(r.capAtMs).toBe(cap * 1000)
    // At the cap the cookie cannot move later, so nothing is minted.
    expect(renewWebSessionCookieValue(r.value, TOKEN, (cap - sec(D)) * 1000, 0)).toBeNull()
    // And it ends there.
    expect(verifyWebSessionCookieValue(r.value, TOKEN, cap * 1000, 0)).toBe(false)
  })
  it('an old 3-part cookie keeps its own 7 days and counts as signed in at its issue time', () => {
    const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    expect(c.value.split('.')).toHaveLength(3)
    expect(verifyWebSessionCookieValue(c.value, TOKEN, NOW + WEB_SESSION_TTL_MS - S, 0)).toBe(true)
    expect(verifyWebSessionCookieValue(c.value, TOKEN, NOW + WEB_SESSION_TTL_MS + S, 0)).toBe(false)
    expect(readWebSessionCookie(c.value, TOKEN, NOW, 0)!.origUnixSec).toBe(sec(NOW))
    const r = renewWebSessionCookieValue(c.value, TOKEN, NOW + 6 * D, 0)!
    expect(r.capAtMs).toBe((sec(NOW) + sec(WEB_SESSION_MAX_LIFE_MS)) * 1000)
  })
  it('an expired or invalid cookie never renews', () => {
    const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    expect(renewWebSessionCookieValue(c.value, TOKEN, NOW + WEB_SESSION_TTL_MS + S, 0)).toBeNull()
    expect(renewWebSessionCookieValue(c.value.replace(/.$/, c.value.endsWith('a') ? 'b' : 'a'), TOKEN, NOW + 6 * D, 0)).toBeNull()
    expect(renewWebSessionCookieValue(undefined, TOKEN, NOW, 0)).toBeNull()
  })
})

describe('readWebSessionCookie: a renewed cookie cannot be stretched', () => {
  it('editing orig breaks the signature', () => {
    const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    const r = renewWebSessionCookieValue(c.value, TOKEN, NOW + 6 * D, 0)!
    const [e, ep, o, g] = r.value.split('.')
    expect(readWebSessionCookie(`${e}.${ep}.${Number(o) + 86400}.${g}`, TOKEN, NOW + 6 * D, 0)).toBeNull()
  })
  it('a signed cookie that claims more than 30 days, or a first sign-in in the future, is refused', () => {
    const orig = sec(NOW) - sec(10 * D)
    const tooLong = orig + sec(WEB_SESSION_MAX_LIFE_MS) + 1
    expect(readWebSessionCookie(`${tooLong}.0.${orig}.${signV3(tooLong, 0, orig)}`, TOKEN, NOW, 0)).toBeNull()
    const ok = orig + sec(WEB_SESSION_MAX_LIFE_MS)
    expect(readWebSessionCookie(`${ok}.0.${orig}.${signV3(ok, 0, orig)}`, TOKEN, NOW, 0)).not.toBeNull()
    const future = sec(NOW) + 3600, exp = future + 100
    expect(readWebSessionCookie(`${exp}.0.${future}.${signV3(exp, 0, future)}`, TOKEN, NOW, 0)).toBeNull()
  })
  it('a 3-part signature never stands for a 4-part cookie', () => {
    const exp = sec(NOW) + sec(D), orig = sec(NOW) - sec(D)
    expect(readWebSessionCookie(`${exp}.0.${sign3(exp, 0)}`, TOKEN, NOW, 0)).not.toBeNull()
    expect(readWebSessionCookie(`${exp}.0.${orig}.${sign3(exp, 0)}`, TOKEN, NOW, 0)).toBeNull()
  })
})

describe('every renewed cookie still ends with "Sign out every browser" and with a new pairing token', () => {
  it('epoch bump after renewal: the renewed cookie stops working', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w1-epoch-'))
    try {
      setWebSessionEpochFile(join(dir, 'web-session.json'))
      const epoch = currentWebSessionEpoch()
      const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, epoch)
      const r = renewWebSessionCookieValue(c.value, TOKEN, NOW + 6 * D, epoch)!
      expect(verifyWebSessionCookieValue(r.value, TOKEN, NOW + 6 * D)).toBe(true)
      bumpWebSessionEpoch()
      expect(verifyWebSessionCookieValue(r.value, TOKEN, NOW + 6 * D)).toBe(false)
      expect(renewWebSessionCookieValue(r.value, TOKEN, NOW + 12 * D)).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('a new pairing token: the renewed cookie stops working', () => {
    const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    const r = renewWebSessionCookieValue(c.value, TOKEN, NOW + 6 * D, 0)!
    expect(verifyWebSessionCookieValue(r.value, TOKEN + 'x', NOW + 6 * D, 0)).toBe(false)
  })
})

describe('the /api gate renews only a request that passed every check', () => {
  async function withGate(fn: (port: number) => Promise<void>) {
    const app = express()
    let port = 0
    app.use('/api', requireApiToken(TOKEN, { selfDnsName: () => null, allowedPorts: () => [port] }))
    app.get('/api/thing', (_q, r) => { r.json({ ok: true }) })
    app.post('/api/thing', (_q, r) => { r.json({ ok: true }) })
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    try { await fn(port) } finally { await new Promise(resolve => server.close(resolve)) }
  }
  // A cookie in its last 2 days, minted on the real clock (the gate reads Date.now()).
  const lateCookie = () => mintWebSessionCookieValue(TOKEN, Date.now() - 6 * D, WEB_SESSION_TTL_MS, currentWebSessionEpoch()).value
  const cookie = (v: string) => `${WEB_SESSION_COOKIE_NAME}=${v}`

  it('a verified browser GET in the window gets a renewed cookie and the header the page reads', async () => {
    await withGate(async port => {
      const res = await fetch(`http://127.0.0.1:${port}/api/thing`, { headers: { cookie: cookie(lateCookie()) } })
      expect(res.status).toBe(200)
      const set = res.headers.get('set-cookie') ?? ''
      expect(set).toMatch(new RegExp(`^${WEB_SESSION_COOKIE_NAME}=\\d+\\.\\d+\\.\\d+\\.[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`))
      const value = set.split(';')[0]!.split('=')[1]!
      expect(verifyWebSessionCookieValue(value, TOKEN)).toBe(true)
      const [exp, cap] = (res.headers.get(WEB_SESSION_RENEWED_HEADER) ?? '').split(' ')
      expect(Date.parse(exp!)).toBeGreaterThan(Date.now() + 6 * D)
      expect(Date.parse(cap!)).toBeGreaterThan(Date.parse(exp!))
    })
  })
  it('a fresh cookie, the token header, an expired cookie and a failed CSRF check never renew', async () => {
    await withGate(async port => {
      const fresh = mintWebSessionCookieValue(TOKEN, Date.now(), WEB_SESSION_TTL_MS, currentWebSessionEpoch()).value
      const a = await fetch(`http://127.0.0.1:${port}/api/thing`, { headers: { cookie: cookie(fresh) } })
      expect(a.status).toBe(200); expect(a.headers.get('set-cookie')).toBeNull()
      const b = await fetch(`http://127.0.0.1:${port}/api/thing`, { headers: { 'x-cos-token': TOKEN, cookie: cookie(lateCookie()) } })
      expect(b.status).toBe(200); expect(b.headers.get('set-cookie')).toBeNull()
      const old = mintWebSessionCookieValue(TOKEN, Date.now() - 8 * D, WEB_SESSION_TTL_MS, currentWebSessionEpoch()).value
      const c = await fetch(`http://127.0.0.1:${port}/api/thing`, { headers: { cookie: cookie(old) } })
      expect(c.status).toBe(401); expect(c.headers.get('set-cookie')).toBeNull()
      // A write without X-COS-Web fails the browser checks: refused, and nothing renewed.
      const d = await fetch(`http://127.0.0.1:${port}/api/thing`, { method: 'POST', headers: { cookie: cookie(lateCookie()) } })
      expect(d.status).toBe(401); expect(d.headers.get('set-cookie')).toBeNull()
      // Behind a proxy (forwarding headers), the browser surface is refused: nothing renewed.
      const e = await fetch(`http://127.0.0.1:${port}/api/thing`, { headers: { cookie: cookie(lateCookie()), 'x-forwarded-for': '192.168.1.20' } })
      expect(e.status).toBe(401); expect(e.headers.get('set-cookie')).toBeNull()
    })
  })
})

// ── Threat cases (lead, 19:5x: re-read as an attacker). Each pins one property in the handoff's threat note. ──
describe('threat cases', () => {
  it('a renewal chain, or a stolen copy renewing on its own, never passes the same 30-day cap', () => {
    const owner = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    const cap = (sec(NOW) + sec(WEB_SESSION_MAX_LIFE_MS)) * 1000
    let cookie = owner.value, t = NOW, last = 0, renewals = 0
    for (let i = 0; i < 20; i++) {
      t += 6 * D                                                   // used once in each cookie's last 2 days
      if (!verifyWebSessionCookieValue(cookie, TOKEN, t, 0)) break
      const r = renewWebSessionCookieValue(cookie, TOKEN, t, 0)
      if (!r) break
      expect(r.expiresAtMs).toBeLessThanOrEqual(cap)
      expect(r.capAtMs).toBe(cap)
      cookie = r.value; last = r.expiresAtMs; renewals++
    }
    expect(renewals).toBeGreaterThan(2)
    expect(last).toBe(cap)
    expect(verifyWebSessionCookieValue(cookie, TOKEN, cap, 0)).toBe(false)
    // A copy of the original cookie taken by someone else renews to the very same cap, not a later one.
    const copy = renewWebSessionCookieValue(owner.value, TOKEN, NOW + 6 * D, 0)!
    expect(copy.capAtMs).toBe(cap)
  })
  it('a renewed cookie with its original-time field removed does not verify as an old cookie', () => {
    const r = renewWebSessionCookieValue(mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0).value, TOKEN, NOW + 6 * D, 0)!
    const [e, ep, , g] = r.value.split('.')
    expect(readWebSessionCookie(`${e}.${ep}.${g}`, TOKEN, NOW + 6 * D, 0)).toBeNull()
  })
  it('the Mac clock moving back: an hour is harmless; past the first sign-in, the cookie fails closed', () => {
    const r = renewWebSessionCookieValue(mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0).value, TOKEN, NOW + 6 * D, 0)!
    expect(verifyWebSessionCookieValue(r.value, TOKEN, NOW + 6 * D - 3600 * S, 0)).toBe(true)
    // A clock set to before the first sign-in makes orig "in the future": refused, so the person signs in again.
    expect(verifyWebSessionCookieValue(r.value, TOKEN, NOW - 60 * S, 0)).toBe(false)
  })
  it('two requests renewing at once: both cookies work, both end at the same cap, and neither renews again soon', () => {
    const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0).value
    const t = NOW + 6 * D
    const a = renewWebSessionCookieValue(c, TOKEN, t, 0)!, b = renewWebSessionCookieValue(c, TOKEN, t + S, 0)!
    expect(verifyWebSessionCookieValue(a.value, TOKEN, t + 2 * S, 0)).toBe(true)
    expect(verifyWebSessionCookieValue(b.value, TOKEN, t + 2 * S, 0)).toBe(true)
    expect(a.capAtMs).toBe(b.capAtMs)
    expect(Math.abs(a.expiresAtMs - b.expiresAtMs)).toBeLessThanOrEqual(S)
    expect(renewWebSessionCookieValue(a.value, TOKEN, t + 2 * S, 0)).toBeNull()
    expect(renewWebSessionCookieValue(b.value, TOKEN, t + 2 * S, 0)).toBeNull()
  })
  it('the old cookie stays valid until its own end after a renewal (no one-time use); it is never extended past it', () => {
    const c = mintWebSessionCookieValue(TOKEN, NOW, WEB_SESSION_TTL_MS, 0)
    renewWebSessionCookieValue(c.value, TOKEN, NOW + 6 * D, 0)
    expect(verifyWebSessionCookieValue(c.value, TOKEN, NOW + 6 * D + S, 0)).toBe(true)
    expect(verifyWebSessionCookieValue(c.value, TOKEN, sec(c.expiresAtMs) * 1000, 0)).toBe(false)
  })
})
