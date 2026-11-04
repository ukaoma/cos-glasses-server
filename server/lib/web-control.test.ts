import { describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasProxyForwardedHeaders,
  isAllowedNetworkIp,
  isAllowedNetworkOrigin,
  isLoopbackSocket,
  normalizeTailscaleDnsName,
} from './network-policy.js'
import { parseTailscaleStatus } from './tailscale-nudge.js'
import {
  isWebSessionAuthorized,
  mintWebSessionCookieValue,
  verifyWebSessionCookieValue,
  WEB_SESSION_COOKIE_NAME,
  WebHandoffStore,
  WebLoginLimiter,
  WEB_LOGIN_MAX_FAILURES,
} from './web-session-auth.js'
import { requireApiToken } from './api-auth.js'
import { createWebControlRouter, isAllowedCorsOrigin, isMemoryWebOpReadOnly, webControlCsp } from '../routes/web-control.js'
import { isReadOnlyApiPost } from './work-search.js'
import { listLiveTranscriptSessions, readLiveTranscriptSession } from './web-live-chunks.js'
import { readFallbackTokenAudit } from './web-usage-bridge.js'

const REAL_DNS_WITH_DOT = 'ukaoma-mac-studio.tail38457f.ts.net.'
const REAL_DNS = 'ukaoma-mac-studio.tail38457f.ts.net'
const API_TOKEN = 'test_secret_token_9876543210'

describe('Tailscale MagicDNS & Loopback Proxy Security (network-policy)', () => {
  it('normalizes production Self.DNSName with trailing dot and rejects non-ts.net or malformed names', () => {
    expect(normalizeTailscaleDnsName(REAL_DNS_WITH_DOT)).toBe(REAL_DNS)
    expect(normalizeTailscaleDnsName('  UKAOMA-MAC-STUDIO.TAIL38457F.TS.NET. ')).toBe(REAL_DNS)
    expect(normalizeTailscaleDnsName('evil.com')).toBeNull()
    expect(normalizeTailscaleDnsName('ukaoma-mac-studio.tail38457f.ts.net.evil.com')).toBeNull()
    expect(normalizeTailscaleDnsName('')).toBeNull()
    expect(normalizeTailscaleDnsName(null)).toBeNull()
  })

  it('admits only localhost, allowed IPs, and the exact verified Self.DNSName on allowed ports', () => {
    // Without selfDnsName, *.ts.net fails closed
    expect(isAllowedNetworkOrigin(`http://${REAL_DNS}:3141`)).toBe(false)

    // With verified selfDnsName (even passed with trailing dot), exact host passes
    expect(isAllowedNetworkOrigin(`http://${REAL_DNS}:3141`, {
      selfDnsName: REAL_DNS_WITH_DOT,
      allowedPorts: [3141, 3143],
    })).toBe(true)

    expect(isAllowedNetworkOrigin(`https://${REAL_DNS}:3143`, {
      selfDnsName: REAL_DNS_WITH_DOT,
      allowedPorts: [3141, 3143],
    })).toBe(true)

    // Lookalike or sibling tailnet peer is rejected
    expect(isAllowedNetworkOrigin('http://other-node.tail38457f.ts.net:3141', {
      selfDnsName: REAL_DNS_WITH_DOT,
      allowedPorts: [3141, 3143],
    })).toBe(false)

    // DNS rebinding domain is rejected
    expect(isAllowedNetworkOrigin('http://evil.com:3141', {
      selfDnsName: REAL_DNS_WITH_DOT,
      allowedPorts: [3141, 3143],
    })).toBe(false)

    // Cross-port on the same host is rejected when allowedPorts is specified
    expect(isAllowedNetworkOrigin(`http://${REAL_DNS}:8080`, {
      selfDnsName: REAL_DNS_WITH_DOT,
      allowedPorts: [3141, 3143],
    })).toBe(false)
    expect(isAllowedNetworkOrigin('http://localhost:8080', {
      selfDnsName: REAL_DNS_WITH_DOT,
      allowedPorts: [3141, 3143],
    })).toBe(false)
    expect(isAllowedNetworkOrigin('http://localhost:3141', {
      selfDnsName: REAL_DNS_WITH_DOT,
      allowedPorts: [3141, 3143],
    })).toBe(true)
  })

  it('admits Tailscale IPv4 CGNAT and IPv6 ULA in isAllowedNetworkIp', () => {
    expect(isAllowedNetworkIp('100.108.149.114')).toBe(true)
    expect(isAllowedNetworkIp('fd7a:115c:a1e0::b239:9573')).toBe(true)
    expect(isAllowedNetworkIp('8.8.8.8')).toBe(false)
  })

  it('refuses loopback privilege when reverse-proxy or tailscale serve headers are present', () => {
    expect(isLoopbackSocket({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })).toBe(true)
    expect(isLoopbackSocket({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} })).toBe(true)

    // tailscale serve or local reverse proxy headers must strip loopback privilege
    expect(hasProxyForwardedHeaders({ 'tailscale-user-login': 'miles@gotcos.com' })).toBe(true)
    expect(isLoopbackSocket({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'tailscale-user-login': 'miles@gotcos.com' },
    })).toBe(false)
    expect(isLoopbackSocket({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '100.108.149.114' },
    })).toBe(false)
    expect(isLoopbackSocket({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { forwarded: 'for=100.108.149.114' },
    })).toBe(false)
  })

  it('parses Self.DNSName and CertDomains in parseTailscaleStatus', () => {
    const sample = JSON.stringify({
      BackendState: 'Running',
      Self: {
        DNSName: REAL_DNS_WITH_DOT,
        TailscaleIPs: ['100.108.149.114', 'fd7a:115c:a1e0::b239:9573'],
      },
      CertDomains: null,
      Peer: {},
    })
    const parsed = parseTailscaleStatus(sample, 1700000000000)
    expect(parsed).not.toBeNull()
    expect(parsed?.selfDnsName).toBe(REAL_DNS)
    expect(parsed?.selfIps).toEqual(['100.108.149.114'])
    expect(parsed?.certDomains).toEqual([])
  })
})

describe('Dedicated Web Session Cookie, CSRF & Handoff Auth', () => {
  it('mints and verifies HMAC session cookies and rejects expired or tampered cookies', () => {
    const now = 1_793_583_600_000
    const minted = mintWebSessionCookieValue(API_TOKEN, now, 60_000)
    expect(verifyWebSessionCookieValue(minted.value, API_TOKEN, now + 10_000)).toBe(true)
    expect(verifyWebSessionCookieValue(minted.value, API_TOKEN, now + 61_000)).toBe(false)
    expect(verifyWebSessionCookieValue(minted.value, 'wrong_token', now + 10_000)).toBe(false)
    expect(verifyWebSessionCookieValue(`${minted.value}0`, API_TOKEN, now + 10_000)).toBe(false)
  })

  it('enforces X-COS-Web: 1 and exact Origin+Port on mutating cookie requests while allowing GET streams', () => {
    const now = 1_793_583_600_000
    const { value } = mintWebSessionCookieValue(API_TOKEN, now, 60_000)
    const cookie = `${WEB_SESSION_COOKIE_NAME}=${value}`
    const opts = { selfDnsName: REAL_DNS, allowedPorts: [3141], nowMs: now + 1_000 }

    // Same-origin GET (e.g., <audio> or EventSource with no Origin header) is allowed
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie } }, API_TOKEN, opts)).toBe(true)

    // Cross-port GET with Origin is rejected
    expect(isWebSessionAuthorized({
      method: 'GET',
      headers: { cookie, origin: `http://${REAL_DNS}:8080` },
    }, API_TOKEN, opts)).toBe(false)

    // POST without X-COS-Web: 1 is rejected (blocks HTML form CSRF)
    expect(isWebSessionAuthorized({
      method: 'POST',
      headers: { cookie, origin: `http://${REAL_DNS}:3141` },
    }, API_TOKEN, opts)).toBe(false)

    // POST with X-COS-Web: 1 but no Origin/Referer is rejected
    expect(isWebSessionAuthorized({
      method: 'POST',
      headers: { cookie, 'x-cos-web': '1' },
    }, API_TOKEN, opts)).toBe(false)

    // POST with X-COS-Web: 1 from wrong port is rejected
    expect(isWebSessionAuthorized({
      method: 'POST',
      headers: { cookie, 'x-cos-web': '1', origin: `http://${REAL_DNS}:8080` },
    }, API_TOKEN, opts)).toBe(false)

    // POST with X-COS-Web: 1 and valid MagicDNS Origin+Port succeeds
    expect(isWebSessionAuthorized({
      method: 'POST',
      headers: { cookie, 'x-cos-web': '1', origin: `http://${REAL_DNS}:3141` },
    }, API_TOKEN, opts)).toBe(true)
  })

  it('consumes loopback handoff tickets exactly once', () => {
    let clock = 1_000_000
    const store = new WebHandoffStore(() => clock)
    const { ticket } = store.mint(10_000)
    expect(store.consume(ticket)).toBe(true)
    expect(store.consume(ticket)).toBe(false)

    const { ticket: expiredTicket } = store.mint(5_000)
    clock += 6_000
    expect(store.consume(expiredTicket)).toBe(false)
  })
})

describe('Lease Exemptions & Route Integration', () => {
  it('exempts /web-bridge/memories and /web-session/* in isReadOnlyApiPost and classifies memory ops', () => {
    expect(isReadOnlyApiPost('POST', '/web-bridge/memories')).toBe(true)
    expect(isReadOnlyApiPost('POST', '/web-session/login')).toBe(true)
    expect(isReadOnlyApiPost('POST', '/web-session/handoff')).toBe(true)

    expect(isMemoryWebOpReadOnly('status', {})).toBe(true)
    expect(isMemoryWebOpReadOnly('graph.ask', { q: 'test' })).toBe(true)
    expect(isMemoryWebOpReadOnly('workspace.request', { action: 'memory_page' })).toBe(true)
    expect(isMemoryWebOpReadOnly('workspace.request', { action: 'review_memory' })).toBe(false)
    expect(isMemoryWebOpReadOnly('memory.guardrails.run', { apply: false })).toBe(true)
    expect(isMemoryWebOpReadOnly('memory.guardrails.run', { apply: true })).toBe(false)
    expect(isMemoryWebOpReadOnly('learning.decide', { id: '1', decision: 'dismissed' })).toBe(false)
  })

  it('authenticates cookie requests via requireApiToken without firing onAuthenticated (protecting G2 pairingState)', async () => {
    let pairingNoted = 0
    const app = express()
    let port = 0
    app.use('/api', requireApiToken(API_TOKEN, {
      onAuthenticated: () => { pairingNoted++ },
      selfDnsName: () => REAL_DNS,
      allowedPorts: () => [port],
    }))
    app.use('/api', createWebControlRouter({
      apiToken: () => API_TOKEN,
      port: () => port,
      selfDnsName: () => REAL_DNS,
      queryTailscaleStatus: async () => ({
        backendState: 'Running',
        selfIps: ['100.108.149.114'],
        selfDnsName: REAL_DNS,
        certDomains: [],
      }),
    }))
    app.post('/api/protected-write', (_req, res) => res.json({ ok: true }))

    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    port = (server.address() as { port: number }).port

    try {
      // 1. Login via POST /api/web-session/login
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/web-session/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: API_TOKEN }),
      })
      expect(loginRes.status).toBe(200)
      const setCookie = loginRes.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('cos_web_session=')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      const cookiePair = setCookie.split(';')[0]

      // 2. GET /api/tailscale/web-url with cookie succeeds and does NOT increment pairingNoted
      const urlRes = await fetch(`http://127.0.0.1:${port}/api/tailscale/web-url`, {
        headers: { Cookie: cookiePair },
      })
      expect(urlRes.status).toBe(200)
      const urlBody = await urlRes.json() as Record<string, unknown>
      expect(urlBody.magicDnsUrl).toBe(`http://${REAL_DNS}:${port}/control`)
      expect(pairingNoted).toBe(0)

      // 3. POST /api/protected-write with cookie but NO X-COS-Web header is rejected (401)
      const csrfFail = await fetch(`http://127.0.0.1:${port}/api/protected-write`, {
        method: 'POST',
        headers: {
          Cookie: cookiePair,
          Origin: `http://${REAL_DNS}:${port}`,
        },
      })
      expect(csrfFail.status).toBe(401)

      // 4. POST /api/protected-write with cookie + X-COS-Web: 1 + valid MagicDNS Origin succeeds
      const csrfPass = await fetch(`http://127.0.0.1:${port}/api/protected-write`, {
        method: 'POST',
        headers: {
          Cookie: cookiePair,
          'X-COS-Web': '1',
          Origin: `http://${REAL_DNS}:${port}`,
        },
      })
      expect(csrfPass.status).toBe(200)
      expect(pairingNoted).toBe(0)

      // 5. Header X-COS-Token still increments pairingNoted as before
      const headerPass = await fetch(`http://127.0.0.1:${port}/api/tailscale/web-url`, {
        headers: { 'X-COS-Token': API_TOKEN },
      })
      expect(headerPass.status).toBe(200)
      expect(pairingNoted).toBe(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('reads live meeting chunks with since, stamp, speakerRevision, and chunkLevels parity', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cos-live-chunks-'))
    try {
      const activeDir = join(tempRoot, 'active-sessions')
      mkdirSync(activeDir, { recursive: true })
      const sessionId = 'mac_1793583600_test'
      const file = join(activeDir, `${sessionId}.json`)
      writeFileSync(file, JSON.stringify({
        sessionId,
        startTime: 1793583600000,
        lastActivityAt: 1793583610000,
        maxChunkIndex: 2,
        receivedIndices: [0, 1, 2],
        asrCompletedIndices: [0, 1, 2],
        speakerRevision: 1,
        chunksIndexed: [
          { i: 0, c: { text: 'Hello team', speaker: 'Miles', elapsed: 0 } },
          { i: 1, c: { text: 'Checking metrics', speaker: 'Unknown', elapsed: 5000 } },
        ],
        speakerProjectedChunksIndexed: [
          { i: 1, c: { text: 'Checking metrics', speaker: 'Voice 1', elapsed: 5000 } },
        ],
        chunkLevels: [
          { i: 0, level: 0.42, speechSec: 3.1 },
          { i: 1, level: 0.68, speechSec: 4.0 },
        ],
      }))

      const list = listLiveTranscriptSessions(tempRoot)
      expect(list).toHaveLength(1)
      expect(list[0].sessionId).toBe(sessionId)

      const first = readLiveTranscriptSession({
        baseDataDir: tempRoot,
        sessionId,
        since: -1,
        knownSpeakerRevision: 1,
      })
      expect(first.ended).toBe(false)
      expect(first.unchanged).toBe(false)
      expect(first.settledThrough).toBe(2)
      expect(first.turns).toHaveLength(2)
      expect(first.turns?.[1].speaker).toBe('Voice 1')
      expect(first.turns?.[1].originalSpeaker).toBe('Unknown')
      expect(first.levels).toHaveLength(2)

      // Calling again with matching stamp returns unchanged: true
      const second = readLiveTranscriptSession({
        baseDataDir: tempRoot,
        sessionId,
        since: 1,
        knownStamp: first.stamp,
        knownSpeakerRevision: 1,
      })
      expect(second.unchanged).toBe(true)

      // Missing session returns ended: true
      const missing = readLiveTranscriptSession({
        baseDataDir: tempRoot,
        sessionId: 'mac_missing_123',
      })
      expect(missing.ended).toBe(true)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('aggregates fallback token-audit.jsonl inside .cos-glasses home dot-directory', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'cos-home-'))
    try {
      const dotDir = join(tempHome, '.cos-glasses')
      mkdirSync(dotDir, { recursive: true })
      writeFileSync(
        join(dotDir, 'token-audit.jsonl'),
        [
          JSON.stringify({ caller: 'g2-query', inputTokens: 1200, outputTokens: 300, costUsd: 0.015 }),
          JSON.stringify({ caller: 'g2-query', inputTokens: 800, outputTokens: 200, costUsd: 0.01 }),
          JSON.stringify({ caller: 'lightrag', tokens: 5000, usd: 0.05 }),
        ].join('\n') + '\n',
      )
      const fallback = readFallbackTokenAudit(tempHome) as { auditFound: boolean; rows: Array<{ category: string; calls: number; estimatedTokens: number; estimatedUSD: number }> }
      expect(fallback.auditFound).toBe(true)
      expect(fallback.rows).toEqual([
        { category: 'g2-query', calls: 2, estimatedTokens: 2500, estimatedUSD: 0.025 },
        { category: 'lightrag', calls: 1, estimatedTokens: 5000, estimatedUSD: 0.05 },
      ])
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})


describe('Web sign-in hardening (limiter, private status, CSP)', () => {
  it('refuses an IP after the failure limit, until its window ends, and a success clears it', () => {
    let now = 1_000_000
    const lim = new WebLoginLimiter(() => now, 3, 60_000)
    expect(lim.blockedFor('100.1.1.1')).toBe(0)
    lim.fail('100.1.1.1'); lim.fail('100.1.1.1')
    expect(lim.blockedFor('100.1.1.1')).toBe(0)
    lim.fail('100.1.1.1')
    expect(lim.blockedFor('100.1.1.1')).toBe(60)
    expect(lim.blockedFor('100.2.2.2')).toBe(0)
    now += 59_000
    expect(lim.blockedFor('100.1.1.1')).toBe(1)
    now += 1_000
    expect(lim.blockedFor('100.1.1.1')).toBe(0)
    lim.fail('100.3.3.3'); lim.fail('100.3.3.3'); lim.succeed('100.3.3.3'); lim.fail('100.3.3.3'); lim.fail('100.3.3.3')
    expect(lim.blockedFor('100.3.3.3')).toBe(0)
  })

  it('answers 429 after repeated wrong tokens, even for the right token, and status leaks nothing when signed out', async () => {
    const app = express()
    let port = 0
    app.use('/api', requireApiToken(API_TOKEN, { selfDnsName: () => REAL_DNS, allowedPorts: () => [port] }))
    app.use('/api', createWebControlRouter({ apiToken: () => API_TOKEN, port: () => port, selfDnsName: () => REAL_DNS }))
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    const login = (token: string) => fetch(`http://127.0.0.1:${port}/api/web-session/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    })
    try {
      const status = await (await fetch(`http://127.0.0.1:${port}/api/web-session/status`)).json() as Record<string, unknown>
      expect(status).toEqual({ authenticated: false, mode: 'none' })

      for (let i = 0; i < WEB_LOGIN_MAX_FAILURES; i++) expect((await login('wrong-token')).status).toBe(401)
      const blocked = await login(API_TOKEN)
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(blocked.headers.get('set-cookie')).toBeNull()
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('serves the shell with script-src self only, and keeps inline scripts for the hosted Memories page alone', () => {
    const shell = webControlCsp('/index.html')
    expect(shell).toContain("script-src 'self';")
    expect(shell).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(webControlCsp('/')).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(webControlCsp('/memories/memories.html')).toMatch(/script-src 'self' 'unsafe-inline'/)
    expect(shell).toContain("frame-ancestors 'self'")
  })

  it('does not exempt the removed /memory/web-op alias from the mutation lease', () => {
    expect(isReadOnlyApiPost('POST', '/memory/web-op')).toBe(false)
  })
})

describe('CORS gate for the tailnet URL (isAllowedCorsOrigin)', () => {
  function fakeDns(learned: string | null) {
    let known: string | null = null
    let reads = 0
    return {
      currentSelfDnsName: () => known,
      queryStatus: async () => { reads++; known = learned; return null },
      reads: () => reads,
    }
  }

  it('reads Tailscale once for an unrecognised *.ts.net origin and admits only this Mac', async () => {
    const dns = fakeDns(REAL_DNS)
    expect(await isAllowedCorsOrigin(`http://${REAL_DNS}:3141`, dns)).toBe(true)
    expect(dns.reads()).toBe(1)
    expect(await isAllowedCorsOrigin(`http://${REAL_DNS}:3141`, dns)).toBe(true)
    expect(dns.reads()).toBe(1)
    expect(await isAllowedCorsOrigin('http://other-mac.tail38457f.ts.net:3141', dns)).toBe(false)
  })

  it('never reads status for localhost, LAN or a non-tailnet origin', async () => {
    const dns = fakeDns(REAL_DNS)
    expect(await isAllowedCorsOrigin('http://localhost:5173', dns)).toBe(true)
    expect(await isAllowedCorsOrigin('http://192.168.1.20:3141', dns)).toBe(true)
    expect(await isAllowedCorsOrigin('https://evil.example.com', dns)).toBe(false)
    expect(await isAllowedCorsOrigin('not a url', dns)).toBe(false)
    expect(dns.reads()).toBe(0)
  })

  it('refuses a *.ts.net origin when Tailscale cannot say who this Mac is', async () => {
    const dns = fakeDns(null)
    expect(await isAllowedCorsOrigin(`http://${REAL_DNS}:3141`, dns)).toBe(false)
    const throwing = { currentSelfDnsName: () => null, queryStatus: async () => { throw new Error('no tailscale') } }
    expect(await isAllowedCorsOrigin(`http://${REAL_DNS}:3141`, throwing)).toBe(false)
  })
})
