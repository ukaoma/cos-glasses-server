/**
 * W1 (audit 02 F2): GET /api/web-session/status tells a signed-in browser when ITS OWN cookie ends, so Control Web can say
 * so a day ahead. The 7-day lifetime is unchanged. Signed-out callers and header (token) callers learn nothing new.
 */
import { describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { requireApiToken } from '../lib/api-auth.js'
import { mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME, WEB_SESSION_MAX_LIFE_MS, WEB_SESSION_TTL_MS } from '../lib/web-session-auth.js'
import { createWebControlRouter, webSessionCookieExpiry } from './web-control.js'

const API_TOKEN = 'w1-test-token-0123456789abcdef'
const DNS = 'test-mac.tail00000.ts.net'

async function withServer(fn: (port: number) => Promise<void>) {
  const app = express()
  let port = 0
  app.use('/api', requireApiToken(API_TOKEN, { selfDnsName: () => DNS, allowedPorts: () => [port] }))
  app.use('/api', createWebControlRouter({ apiToken: () => API_TOKEN, port: () => port, selfDnsName: () => DNS }))
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as { port: number }).port
  try { await fn(port) } finally { await new Promise(resolve => server.close(resolve)) }
}

describe('web-session status: the signed-in cookie’s own expiry (W1)', () => {
  it('a cookie browser gets expiresAt equal to the cookie’s signed expiry', async () => {
    await withServer(async port => {
      const minted = mintWebSessionCookieValue(API_TOKEN, Date.now(), WEB_SESSION_TTL_MS)
      const res = await fetch(`http://127.0.0.1:${port}/api/web-session/status`, { headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${minted.value}` } })
      const body = await res.json() as Record<string, unknown>
      expect(body.authenticated).toBe(true)
      expect(body.mode).toBe('cookie')
      expect(body.expiresAt).toBe(new Date(Math.floor(minted.expiresAtMs / 1000) * 1000).toISOString())
      // Renewal: the latest this sign-in can reach while in use, 30 days from its issue time (exp minus 7 days).
      const exp = Math.floor(minted.expiresAtMs / 1000)
      expect(body.renewUntil).toBe(new Date((exp - WEB_SESSION_TTL_MS / 1000 + WEB_SESSION_MAX_LIFE_MS / 1000) * 1000).toISOString())
    })
  })
  it('signed out: no expiry and nothing else new', async () => {
    await withServer(async port => {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/web-session/status`)).json()
      expect(body).toEqual({ authenticated: false, mode: 'none' })
      // A forged cookie (bad signature) is signed out too, and its expiry is never echoed.
      const forged = `${Math.floor(Date.now() / 1000) + 999}.0.${'a'.repeat(64)}`
      const f = await (await fetch(`http://127.0.0.1:${port}/api/web-session/status`, { headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${forged}` } })).json()
      expect(f).toEqual({ authenticated: false, mode: 'none' })
    })
  })
  it('a token (header) caller gets no expiresAt: it has no cookie that ends', async () => {
    await withServer(async port => {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/web-session/status`, { headers: { 'x-cos-token': API_TOKEN } })).json() as Record<string, unknown>
      expect(body.mode).toBe('header')
      expect('expiresAt' in body).toBe(false)
      expect('renewUntil' in body).toBe(false)
    })
  })
  it('Q1 S1: with two session cookies on the request, the expiry comes from the one the verifier reads (the last)', async () => {
    await withServer(async port => {
      const real = mintWebSessionCookieValue(API_TOKEN, Date.now(), WEB_SESSION_TTL_MS)
      const planted = `${Math.floor(Date.now() / 1000) + 999999}.0.${'c'.repeat(64)}`
      const body = await (await fetch(`http://127.0.0.1:${port}/api/web-session/status`, { headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${planted}; ${WEB_SESSION_COOKIE_NAME}=${real.value}` } })).json() as Record<string, unknown>
      expect(body.authenticated).toBe(true)
      expect(body.expiresAt).toBe(new Date(Math.floor(real.expiresAtMs / 1000) * 1000).toISOString())
    })
  })
  it('webSessionCookieExpiry reads only the session cookie’s first part', () => {
    expect(webSessionCookieExpiry(`other=1; ${WEB_SESSION_COOKIE_NAME}=1794226993.0.${'b'.repeat(64)}`)).toBe(new Date(1794226993000).toISOString())
    expect(webSessionCookieExpiry('other=1794226993.0.x')).toBeNull()
    expect(webSessionCookieExpiry(`${WEB_SESSION_COOKIE_NAME}=nope`)).toBeNull()
    expect(webSessionCookieExpiry(undefined)).toBeNull()
  })
})
