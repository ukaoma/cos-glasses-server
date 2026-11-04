import { describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  WebDeviceCodeStore,
  normalizeDeviceCode,
  normalizePastedToken,
  classifyWebLogin,
  setWebSessionEpochFile,
  currentWebSessionEpoch,
  bumpWebSessionEpoch,
} from './web-session-auth.js'
import { requireApiToken } from './api-auth.js'
import { createWebControlRouter, isAllowedCorsOrigin, isMemoryWebOpReadOnly, webControlCsp, WEB_LOGIN_FAILURE_MESSAGE } from '../routes/web-control.js'
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
    // The phone, over Tailscale, at the MagicDNS URL: the socket is its 100.x address and the
    // browser's Host header is the name it typed.
    const socket = { remoteAddress: '100.83.140.84' }
    const host = `${REAL_DNS}:3141`

    // Same-origin GET (e.g., <audio> or EventSource with no Origin header) is allowed
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie }, socket }, API_TOKEN, opts)).toBe(true)

    // Cross-port GET with Origin is rejected
    expect(isWebSessionAuthorized({
      method: 'GET',
      socket,
      headers: { host, cookie, origin: `http://${REAL_DNS}:8080` },
    }, API_TOKEN, opts)).toBe(false)

    // POST without X-COS-Web: 1 is rejected (blocks HTML form CSRF)
    expect(isWebSessionAuthorized({
      method: 'POST',
      socket,
      headers: { host, cookie, origin: `http://${REAL_DNS}:3141` },
    }, API_TOKEN, opts)).toBe(false)

    // POST with X-COS-Web: 1 but no Origin/Referer is rejected
    expect(isWebSessionAuthorized({
      method: 'POST',
      socket,
      headers: { host, cookie, 'x-cos-web': '1' },
    }, API_TOKEN, opts)).toBe(false)

    // POST with X-COS-Web: 1 from wrong port is rejected
    expect(isWebSessionAuthorized({
      method: 'POST',
      socket,
      headers: { host, cookie, 'x-cos-web': '1', origin: `http://${REAL_DNS}:8080` },
    }, API_TOKEN, opts)).toBe(false)

    // POST with X-COS-Web: 1 and valid MagicDNS Origin+Port succeeds
    expect(isWebSessionAuthorized({
      method: 'POST',
      socket,
      headers: { host, cookie, 'x-cos-web': '1', origin: `http://${REAL_DNS}:3141` },
    }, API_TOKEN, opts)).toBe(true)

    // Review W3: another machine's page on an allowed LAN address and port, sent to this Mac.
    // The allowlist alone admits it; the Origin must also name the host the browser reached.
    expect(isWebSessionAuthorized({
      method: 'POST',
      socket,
      headers: { host, cookie, 'x-cos-web': '1', origin: 'http://192.168.1.50:3141' },
    }, API_TOKEN, opts)).toBe(false)
    // A DNS-rebinding page matches its own Host but is not on the allowlist.
    expect(isWebSessionAuthorized({
      method: 'POST',
      socket,
      headers: { host: 'evil.example.com:3141', cookie, 'x-cos-web': '1', origin: 'http://evil.example.com:3141' },
    }, API_TOKEN, opts)).toBe(false)

    // Review W2: home Wi-Fi is refused unless COS_WEB_CONTROL_LAN=1, whatever the cookie says.
    const lan = { remoteAddress: '192.168.1.20' }
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie }, socket: lan }, API_TOKEN, opts)).toBe(false)
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie }, socket: lan }, API_TOKEN, { ...opts, env: { COS_WEB_CONTROL_LAN: '1' } })).toBe(true)
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie } }, API_TOKEN, opts)).toBe(false)

    // An IPv4-mapped tailnet socket is a tailnet socket.
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie }, socket: { remoteAddress: '::ffff:100.83.140.84' } }, API_TOKEN, opts)).toBe(true)
    // Review W4: anything carrying proxy headers is refused, even on loopback (tailscale serve, Funnel).
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie, 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } }, API_TOKEN, opts)).toBe(false)
    expect(isWebSessionAuthorized({ method: 'GET', headers: { cookie, 'tailscale-user-login': 'x@example.com' }, socket: { remoteAddress: '127.0.0.1' } }, API_TOKEN, opts)).toBe(false)
    // Writes: a missing Host is refused; 3141 page writing to 3143 (or back) is refused.
    expect(isWebSessionAuthorized({ method: 'POST', socket, headers: { cookie, 'x-cos-web': '1', origin: `http://${REAL_DNS}:3141` } }, API_TOKEN, opts)).toBe(false)
    const both = { ...opts, allowedPorts: [3141, 3143] }
    expect(isWebSessionAuthorized({ method: 'POST', socket, headers: { host: `${REAL_DNS}:3143`, cookie, 'x-cos-web': '1', origin: `http://${REAL_DNS}:3141` } }, API_TOKEN, both)).toBe(false)
    expect(isWebSessionAuthorized({ method: 'POST', socket, headers: { host: `${REAL_DNS}:3143`, cookie, 'x-cos-web': '1', origin: `https://${REAL_DNS}:3143` } }, API_TOKEN, both)).toBe(true)
    // A Tailscale IPv6 page writing to the address it reached.
    const v6 = { remoteAddress: 'fd7a:115c:a1e0::5' }
    expect(isWebSessionAuthorized({ method: 'POST', socket: v6, headers: { host: '[fd7a:115c:a1e0::1]:3141', cookie, 'x-cos-web': '1', origin: 'http://[fd7a:115c:a1e0::1]:3141' } }, API_TOKEN, opts)).toBe(true)
    expect(isWebSessionAuthorized({ method: 'POST', socket: v6, headers: { host: '[fd7a:115c:a1e0::1]:3141', cookie, 'x-cos-web': '1', origin: 'http://[fd7a:115c:a1e0::2]:3141' } }, API_TOKEN, opts)).toBe(false)
  })

  it('signs the session epoch: "Sign out every browser" kills every copy of every cookie', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-web-epoch-'))
    setWebSessionEpochFile(join(dir, 'web-session.json'))
    const file = join(dir, 'web-session.json')
    try {
      // A first run starts the epoch from the clock, never from 0 (review W5).
      const first = currentWebSessionEpoch()
      expect(first).toBeGreaterThan(1_700_000_000)
      const before = mintWebSessionCookieValue(API_TOKEN).value
      expect(verifyWebSessionCookieValue(before, API_TOKEN)).toBe(true)
      expect(bumpWebSessionEpoch()).toBe(first + 1)
      expect(verifyWebSessionCookieValue(before, API_TOKEN)).toBe(false)
      const after = mintWebSessionCookieValue(API_TOKEN).value
      expect(verifyWebSessionCookieValue(after, API_TOKEN)).toBe(true)
      // Persisted: a restart (fresh cache) still refuses the old cookie.
      setWebSessionEpochFile(file)
      expect(currentWebSessionEpoch()).toBe(first + 1)
      expect(verifyWebSessionCookieValue(before, API_TOKEN)).toBe(false)
      // A forged epoch fails the signature.
      const [exp, , sig] = before.split('.')
      expect(verifyWebSessionCookieValue(`${exp}.${first + 1}.${sig}`, API_TOKEN)).toBe(false)
      // A corrupt file never rolls back: the epoch moves forward and every old cookie dies.
      writeFileSync(file, '{not json')
      setWebSessionEpochFile(file)
      const recovered = currentWebSessionEpoch()
      expect(recovered).toBeGreaterThanOrEqual(first)
      expect(recovered).not.toBe(first + 1)
      expect(verifyWebSessionCookieValue(after, API_TOKEN)).toBe(false)
      expect(JSON.parse(readFileSync(file, 'utf8')).epoch).toBe(recovered)
      // A deleted file does the same.
      rmSync(file)
      setWebSessionEpochFile(file)
      expect(verifyWebSessionCookieValue(after, API_TOKEN)).toBe(false)
    } finally {
      setWebSessionEpochFile(null)
      rmSync(dir, { recursive: true, force: true })
    }
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

      // 4. POST with cookie + X-COS-Web: 1 + the Origin of the address this browser reached succeeds
      const csrfPass = await fetch(`http://127.0.0.1:${port}/api/protected-write`, {
        method: 'POST',
        headers: {
          Cookie: cookiePair,
          'X-COS-Web': '1',
          Origin: `http://127.0.0.1:${port}`,
        },
      })
      expect(csrfPass.status).toBe(200)
      expect(pairingNoted).toBe(0)

      // 4b. Review W3: an allowed Origin that is not the host this request reached is refused
      const otherHost = await fetch(`http://127.0.0.1:${port}/api/protected-write`, {
        method: 'POST',
        headers: { Cookie: cookiePair, 'X-COS-Web': '1', Origin: `http://${REAL_DNS}:${port}` },
      })
      expect(otherHost.status).toBe(401)

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

describe('Sign-in codes for another device', () => {
  it('mints 8-character Crockford codes that work once and read the way people type them', () => {
    const store = new WebDeviceCodeStore()
    const { code, display } = store.mint()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(display).toBe(`${code.slice(0, 4)}-${code.slice(4)}`)
    expect(normalizeDeviceCode(` ${display.toLowerCase()} `)).toBe(code)
    expect(normalizeDeviceCode('O0IL-1111')).toBe('00111111')
    expect(normalizeDeviceCode('SHORT')).toBeNull()
    expect(normalizeDeviceCode('UUUUUUUU')).toBeNull()
    expect(store.consume(display.toLowerCase())).toBe(true)
    expect(store.consume(display)).toBe(false)
  })

  it('expires codes after five minutes and keeps at most four alive', () => {
    let now = 5_000_000
    const store = new WebDeviceCodeStore(() => now)
    const first = store.mint()
    now += 5 * 60_000
    expect(store.consume(first.code)).toBe(false)
    const codes = [store.mint(), store.mint(), store.mint(), store.mint(), store.mint()].map(c => c.code)
    expect(store.consume(codes[0])).toBe(false)
    expect(store.consume(codes[4])).toBe(true)
  })

  it('signs a phone in with a code a signed-in caller minted, once, and refuses minting without sign-in', async () => {
    const app = express()
    let port = 0
    app.use('/api', requireApiToken(API_TOKEN, { selfDnsName: () => REAL_DNS, allowedPorts: () => [port] }))
    app.use('/api', express.json())
    app.use('/api', createWebControlRouter({ apiToken: () => API_TOKEN, port: () => port, selfDnsName: () => REAL_DNS }))
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}/api`
    try {
      expect((await fetch(`${base}/web-session/device-code`, { method: 'POST' })).status).toBe(401)
      const minted = await (await fetch(`${base}/web-session/device-code`, { method: 'POST', headers: { 'X-COS-Token': API_TOKEN } })).json() as { code: string }
      expect(minted.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
      const login = (code: string) => fetch(`${base}/web-session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
      const ok = await login(minted.code.toLowerCase())
      expect(ok.status).toBe(200)
      expect(ok.headers.get('set-cookie') ?? '').toContain('cos_web_session=')
      expect((await login(minted.code)).status).toBe(401)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('Sign-in failures say what went wrong (6.99.3)', () => {
  it('cleans a pasted token: spaces, line breaks, zero-width characters and wrapping quotes', () => {
    expect(normalizePastedToken(`  ${API_TOKEN}\n`)).toBe(API_TOKEN)
    expect(normalizePastedToken(`\u200B${API_TOKEN}\uFEFF`)).toBe(API_TOKEN)
    expect(normalizePastedToken(`"${API_TOKEN}"`)).toBe(API_TOKEN)
    expect(normalizePastedToken(`\u201C${API_TOKEN}\u201D `)).toBe(API_TOKEN)
    expect(normalizePastedToken(`'${API_TOKEN}'`)).toBe(API_TOKEN)
    expect(normalizePastedToken(`${API_TOKEN.slice(0, 10)}\u00A0${API_TOKEN.slice(10)}`)).toBe(API_TOKEN)
    expect(normalizePastedToken(undefined)).toBe('')
    const handoffs = new WebHandoffStore()
    expect(classifyWebLogin({ token: ` "${API_TOKEN}"\u200B\n` }, API_TOKEN, handoffs)).toEqual({ ok: true, kind: 'token' })
  })

  it('names each failure, and asks about the glasses code only after a web code fails', () => {
    const handoffs = new WebHandoffStore()
    const codes = new WebDeviceCodeStore()
    const asked: string[] = []
    const glasses = (code: string) => { asked.push(code); return code === 'K7P3QX9M' }
    expect(classifyWebLogin({ token: 'nope' }, API_TOKEN, handoffs, codes, glasses)).toEqual({ ok: false, reason: 'wrong_token', length: 4 })
    expect(classifyWebLogin({ handoff: 'A'.repeat(32) }, API_TOKEN, handoffs, codes, glasses)).toEqual({ ok: false, reason: 'handoff_expired', length: 32 })
    expect(classifyWebLogin({ code: 'k7p3-qx9m' }, API_TOKEN, handoffs, codes, glasses)).toEqual({ ok: false, reason: 'glasses_code', length: 8 })
    expect(classifyWebLogin({ code: 'AAAA-AAAA' }, API_TOKEN, handoffs, codes, glasses)).toEqual({ ok: false, reason: 'wrong_code', length: 8 })
    expect(classifyWebLogin({ code: 'abc' }, API_TOKEN, handoffs, codes, glasses)).toEqual({ ok: false, reason: 'wrong_code', length: 3 })
    expect(classifyWebLogin({}, API_TOKEN, handoffs, codes, glasses)).toEqual({ ok: false, reason: 'missing', length: 0 })
    // A real web code signs in without ever asking about the glasses code.
    asked.length = 0
    const minted = codes.mint()
    expect(classifyWebLogin({ code: minted.display }, API_TOKEN, handoffs, codes, glasses)).toEqual({ ok: true, kind: 'code' })
    expect(asked).toEqual([])
    // A glasses check that throws reads as a plain wrong code.
    expect(classifyWebLogin({ code: 'AAAA-AAAA' }, API_TOKEN, handoffs, codes, () => { throw new Error('boom') })).toEqual({ ok: false, reason: 'wrong_code', length: 8 })
  })

  it('answers 401 with the reason and message, logs kind and length only, and the lockout names the last failure', async () => {
    const app = express()
    let port = 0
    const logs: string[] = []
    app.use('/api', requireApiToken(API_TOKEN, { selfDnsName: () => REAL_DNS, allowedPorts: () => [port] }))
    app.use('/api', createWebControlRouter({
      apiToken: () => API_TOKEN, port: () => port, selfDnsName: () => REAL_DNS,
      glassesCodeIsLive: code => code === 'K7P3QX9M',
      log: line => logs.push(line),
    }))
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    const login = (body: Record<string, string>) => fetch(`http://127.0.0.1:${port}/api/web-session/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    try {
      const wrongToken = await login({ token: 'secret-guess-value' })
      expect(wrongToken.status).toBe(401)
      expect(await wrongToken.json()).toEqual({ ok: false, error: 'invalid_credentials', reason: 'wrong_token', message: WEB_LOGIN_FAILURE_MESSAGE.wrong_token })
      const glassesCode = await login({ code: 'K7P3-QX9M' })
      expect(await glassesCode.json()).toMatchObject({ reason: 'glasses_code', message: WEB_LOGIN_FAILURE_MESSAGE.glasses_code })
      expect(logs).toEqual([
        '[web-login] fail kind=wrong_token len=18 ip=127.0.0.1',
        '[web-login] fail kind=glasses_code len=8 ip=127.0.0.1',
      ])
      expect(logs.join('\n')).not.toContain('secret-guess-value')
      expect(logs.join('\n')).not.toContain('K7P3')
      for (let i = 2; i < WEB_LOGIN_MAX_FAILURES; i++) expect((await login({ code: 'K7P3QX9M' })).status).toBe(401)
      const blocked = await login({ token: API_TOKEN })
      expect(blocked.status).toBe(429)
      const body = await blocked.json() as { reason: string; message: string }
      expect(body.reason).toBe('glasses_code')
      expect(body.message).toMatch(/^Too many failed sign-ins from this device\. Try again in 10 min\. The last try was the glasses pairing code/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('logs a successful sign-in by kind only', async () => {
    const app = express()
    let port = 0
    const logs: string[] = []
    app.use('/api', requireApiToken(API_TOKEN, { selfDnsName: () => REAL_DNS, allowedPorts: () => [port] }))
    app.use('/api', createWebControlRouter({ apiToken: () => API_TOKEN, port: () => port, selfDnsName: () => REAL_DNS, log: line => logs.push(line) }))
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web-session/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: `"${API_TOKEN}"\n` }),
      })
      expect(res.status).toBe(200)
      expect(logs).toEqual(['[web-login] ok kind=token ip=127.0.0.1'])
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('handoff gives the phone one tailnet link (the name when known) plus the loopback link', async () => {
    let port = 0
    let name: string | null = REAL_DNS_WITH_DOT
    let ip: string | null = '100.108.149.114'
    const app = express()
    app.use('/api', requireApiToken(API_TOKEN, { selfDnsName: () => REAL_DNS, allowedPorts: () => [port] }))
    app.use('/api', createWebControlRouter({
      apiToken: () => API_TOKEN, port: () => port, publicPort: () => 3141,
      selfDnsName: () => name, tailnetIpv4: () => ip, log: () => {},
    }))
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    const mint = async () => (await fetch(`http://127.0.0.1:${port}/api/web-session/handoff`, { method: 'POST', headers: { 'X-COS-Token': API_TOKEN } })).json() as Promise<Record<string, any>>
    try {
      const both = await mint()
      const q = `/control?handoff=${both.ticket}`
      expect(both.url).toBe(`http://127.0.0.1:3141${q}`)
      expect(both.tailnet).toEqual({ ipUrl: `http://100.108.149.114:3141${q}`, nameUrl: `http://${REAL_DNS}:3141${q}` })
      expect(both.phoneUrl).toBe(`http://${REAL_DNS}:3141${q}`)

      name = null
      const ipOnly = await mint()
      expect(ipOnly.tailnet.nameUrl).toBeNull()
      expect(ipOnly.phoneUrl).toBe(`http://100.108.149.114:3141/control?handoff=${ipOnly.ticket}`)

      ip = null
      const none = await mint()
      expect(none.phoneUrl).toBeNull()
      expect(none.tailnet).toEqual({ ipUrl: null, nameUrl: null })

      // The phone signs in with the ticket from its link, once.
      const login = (handoff: string) => fetch(`http://127.0.0.1:${port}/api/web-session/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handoff }),
      })
      expect((await login(both.ticket)).status).toBe(200)
      const reused = await login(both.ticket)
      expect(reused.status).toBe(401)
      expect(await reused.json()).toMatchObject({ reason: 'handoff_expired' })
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
