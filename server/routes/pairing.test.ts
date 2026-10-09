import express, { type RequestHandler } from 'express'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireApiToken } from '../lib/api-auth.js'
import { isAllowedNetworkIp } from '../lib/network-policy.js'
import { PAIRING_QR_PATTERN, PairingState } from '../lib/glasses-pairing.js'
import { createPairingRouter } from './pairing.js'

const TOKEN = 'route-test-pairing-token-0123456789abcdef'
const TS_IP = '100.81.195.27'
const TS_IP_2 = '100.90.1.2'
const LAN_IP = '192.168.1.50'
const NONCE = 'phoneNonce_0123456789abcdef'
const NONCE_2 = 'phoneNonce_ZYXWVUTSRQPONMLK'

let clock = Date.UTC(2026, 9, 9, 12, 0, 0)
let state: PairingState
let draining = false
let server: Server
let base = ''

function freshState(): PairingState {
  return new PairingState({
    now: () => clock,
    token: () => TOKEN,
    serverName: () => 'Test-Mac',
    hosts: lan => [
      { host: '100.64.1.1', port: 3141, kind: 'tailscale' },
      ...(lan ? [{ host: '192.168.1.204', port: 3141, kind: 'lan' as const }] : []),
    ],
  })
}

// Test-only stand-in for "this request arrived on a socket from <ip>". It overrides
// the SOCKET's remoteAddress (what production reads), so a route that read req.ip or
// X-Forwarded-For instead would see the real loopback address and fail these tests.
const fakeSocketIp: RequestHandler = (req, _res, next) => {
  const ip = req.headers['x-test-socket-ip']
  Object.defineProperty(req.socket, 'remoteAddress', {
    value: typeof ip === 'string' ? ip : '127.0.0.1',
    configurable: true,
  })
  next()
}

// The production network allowlist, so a LAN or Tailscale socket reaches the router.
const networkAllowlist: RequestHandler = (req, res, next) => {
  if (!isAllowedNetworkIp(req.ip || req.socket.remoteAddress || '')) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  next()
}

// Stands in for index.ts's mutation-lease catch-all while the server drains: it
// refuses every mutation. The pairing routes are mounted before it and must never
// reach it.
let leaseHits = 0
const closedMutationLease: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next()
  leaseHits++
  res.status(503).json({ error: 'maintenance_draining' })
}

beforeAll(async () => {
  const app = express()
  app.use(fakeSocketIp)
  app.use(networkAllowlist)
  app.use('/api', requireApiToken(TOKEN, {
    onAuthenticated: req => state.noteAuthenticated(req.socket?.remoteAddress),
  }))
  app.use('/api', createPairingRouter({ state: () => state, isDraining: () => draining }))
  app.use('/api', closedMutationLease)
  app.use(express.json({ limit: '10mb' }))
  app.get('/api/models', (_req, res) => res.json({ ok: true }))
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  clock = Date.UTC(2026, 9, 9, 12, 0, 0)
  state = freshState()
  draining = false
  leaseHits = 0
})

type Init = { method?: string; ip?: string; token?: boolean; body?: unknown; headers?: Record<string, string>; raw?: string }
async function call(path: string, init: Init = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.ip) headers['x-test-socket-ip'] = init.ip
  if (init.token) headers['x-cos-token'] = TOKEN
  let body: string | undefined
  if (init.raw !== undefined) {
    body = init.raw
    headers['content-type'] = 'application/json'
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers['content-type'] = 'application/json'
  }
  const response = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body })
  const text = await response.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  return { status: response.status, json, headers: response.headers }
}

async function mint(body: unknown = {}) {
  const result = await call('/api/pairing/code', { method: 'POST', token: true, body })
  expect(result.status).toBe(200)
  return result.json as { code: string; display: string; qr: string; expiresAt: string; bootId: string; hosts: unknown[]; lanArmedUntil: string | null }
}

const claim = (code: string, nonce: string, ip: string, headers?: Record<string, string>) =>
  call('/api/pairing/claim', { method: 'POST', ip, body: { code, nonce }, headers })

describe('POST /api/pairing/code', () => {
  it('mints over loopback with the token, in the contract shape', async () => {
    const minted = await mint()
    expect(Object.keys(minted).sort()).toEqual(['bootId', 'code', 'display', 'expiresAt', 'hosts', 'lanArmedUntil', 'qr'])
    expect(minted.qr).toMatch(PAIRING_QR_PATTERN)
    expect(minted.qr).toMatch(/^[A-Z0-9/:+.]+$/)
    expect(minted.hosts).toEqual([{ host: '100.64.1.1', port: 3141, kind: 'tailscale' }])
    expect(minted.bootId).toBe(state.bootId)
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts the loopback form %s', async ip => {
    const result = await call('/api/pairing/code', { method: 'POST', token: true, ip, body: {} })
    expect(result.status).toBe(200)
  })

  it('arms LAN with allowLan', async () => {
    const minted = await mint({ allowLan: true })
    expect(minted.lanArmedUntil).not.toBeNull()
    expect(minted.qr).toContain('+192.168.1.204:3141/')
  })

  it.each([TS_IP, LAN_IP])('refuses a non-loopback socket (%s) even with the token', async ip => {
    const result = await call('/api/pairing/code', { method: 'POST', token: true, ip, body: {} })
    expect(result.status).toBe(403)
    expect(result.json.reason).toBe('not_loopback')
  })

  it('does not trust X-Forwarded-For for the loopback check', async () => {
    const result = await call('/api/pairing/code', {
      method: 'POST', token: true, ip: TS_IP, body: {}, headers: { 'x-forwarded-for': '127.0.0.1' },
    })
    expect(result.json.reason).toBe('not_loopback')
  })

  it('needs the token (401), and GET is never a mint door', async () => {
    expect((await call('/api/pairing/code', { method: 'POST', body: {} })).status).toBe(401)
    expect((await call('/api/pairing/code')).status).toBe(401)
    expect((await call('/api/pairing/code', { method: 'GET', ip: TS_IP })).status).toBe(401)
  })
})

describe('POST /api/pairing/claim and GET /api/pairing/claim/:nonce', () => {
  it('runs the whole Allow flow, returning the token once', async () => {
    const { code } = await mint()
    const claimed = await claim(code, NONCE, TS_IP)
    expect(claimed.status).toBe(202)
    expect(claimed.json).toEqual({ pending: true })
    expect((await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })).json).toEqual({ state: 'pending' })

    const status = await call('/api/pairing/status', { token: true })
    expect(status.json.pending).toMatchObject({ nonce: NONCE, ip: TS_IP })
    expect((await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })).json)
      .toEqual({ ok: true })

    const first = await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    expect(first.json).toEqual({ state: 'allowed', token: TOKEN, serverName: 'Test-Mac' })
    expect(first.headers.get('cache-control')).toBe('no-store')
    const second = await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    expect(second.json).toEqual({ state: 'delivered', serverName: 'Test-Mac' })
    expect(JSON.stringify(second.json)).not.toContain(TOKEN)
  })

  it('stamps firstAuthAfterClaimAt on the first token request from the claiming IP', async () => {
    const { code } = await mint()
    await claim(code, NONCE, TS_IP)
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    // The public poll itself is not an authenticated call.
    await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    // Control's own loopback status read is authenticated but from another IP.
    expect((await call('/api/pairing/status', { token: true })).json.firstAuthAfterClaimAt).toBeNull()
    // A wrong token from the phone's IP does not count.
    await call('/api/models', { ip: TS_IP, headers: { 'x-cos-token': 'wrong' } })
    expect((await call('/api/pairing/status', { token: true })).json.firstAuthAfterClaimAt).toBeNull()
    expect((await call('/api/models', { ip: TS_IP, token: true })).status).toBe(200)
    expect((await call('/api/pairing/status', { token: true })).json.firstAuthAfterClaimAt).toBe(new Date(clock).toISOString())
  })

  it('the deny path answers denied and never the token', async () => {
    const { code } = await mint()
    await claim(code, NONCE, TS_IP)
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: false } })
    const polled = await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    expect(polled.json).toEqual({ state: 'denied' })
  })

  it('a HEAD poll never spends the token, even with the token header', async () => {
    const { code } = await mint()
    await claim(code, NONCE, TS_IP)
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    // Without the token, HEAD is not a public door at all.
    expect((await call(`/api/pairing/claim/${NONCE}`, { method: 'HEAD', ip: TS_IP })).status).toBe(401)
    // With it, the handler refuses anything but GET.
    const head = await call(`/api/pairing/claim/${NONCE}`, { method: 'HEAD', ip: TS_IP, token: true })
    expect(head.status).toBe(405)
    expect(head.headers.get('allow')).toBe('GET')
    expect((await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })).json.token).toBe(TOKEN)
  })

  it('refuses a poll from a different socket IP and does not spend the token', async () => {
    const { code } = await mint()
    await claim(code, NONCE, TS_IP)
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    const wrong = await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP_2 })
    expect(wrong.status).toBe(403)
    expect(wrong.json.reason).toBe('not_allowed_network')
    const spoofed = await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP_2, headers: { 'x-forwarded-for': TS_IP } })
    expect(spoofed.json.reason).toBe('not_allowed_network')
    expect((await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })).json.token).toBe(TOKEN)
  })

  it('refuses claims from loopback and from LAN unless armed; arming lasts 10 minutes', async () => {
    let { code } = await mint()
    expect((await claim(code, NONCE, '127.0.0.1')).json.reason).toBe('not_allowed_network')
    const lan = await claim(code, NONCE, LAN_IP)
    expect(lan.status).toBe(403)
    expect(lan.json.reason).toBe('not_allowed_network')

    ;({ code } = await mint({ allowLan: true }))
    clock += 10 * 60_000
    expect((await claim(code, NONCE, LAN_IP)).json.reason).toBe('not_allowed_network')

    ;({ code } = await mint({ allowLan: true }))
    expect((await claim(code, NONCE, LAN_IP)).status).toBe(202)
  })

  it('a public address never reaches the router (the global allowlist stays on top)', async () => {
    const result = await claim('ZZZZZZZZ', NONCE, '203.0.113.9')
    expect(result.status).toBe(403)
    expect(result.json).toEqual({ error: 'forbidden' })
  })

  it('limits by socket IP: a spoofed X-Forwarded-For does not change the bucket', async () => {
    await mint()
    for (let i = 0; i < 5; i++) {
      const result = await claim('ZZZZZZZZ', `${NONCE}${i}`, TS_IP, { 'x-forwarded-for': `100.99.0.${i + 1}` })
      expect(result.json.reason).toBe('unknown_code')
    }
    const limited = await claim('ZZZZZZZZ', `${NONCE}x`, TS_IP, { 'x-forwarded-for': '100.99.9.9' })
    expect(limited.status).toBe(429)
    expect(limited.json.reason).toBe('rate_limited')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('locks the code after 20 attempts', async () => {
    const { code } = await mint()
    for (let i = 0; i < 20; i++) await claim('ZZZZZZZZ', `${NONCE}${i}`, `100.70.0.${i + 1}`)
    const locked = await claim(code, NONCE_2, TS_IP)
    expect(locked.status).toBe(409)
    expect(locked.json.reason).toBe('locked')
  })

  it('a second claim while pending is locked and the first still completes', async () => {
    const { code } = await mint()
    await claim(code, NONCE, TS_IP)
    const second = await claim(code, NONCE_2, TS_IP_2)
    expect(second.json.reason).toBe('locked')
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    expect((await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })).json.state).toBe('allowed')
  })

  it('expires codes at 5 minutes and pending claims at 60 s', async () => {
    let { code } = await mint()
    clock += 5 * 60_000
    const expired = await claim(code, NONCE, TS_IP)
    expect(expired.status).toBe(410)
    expect(expired.json.reason).toBe('expired')

    ;({ code } = await mint())
    await claim(code, NONCE_2, TS_IP)
    clock += 60_000
    expect((await call(`/api/pairing/claim/${NONCE_2}`, { ip: TS_IP })).json).toEqual({ state: 'expired' })
    const late = await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE_2, allow: true } })
    expect(late.json.reason).toBe('expired')
  })

  it('answers unknown_code after a restart (a new state instance)', async () => {
    const { code, bootId } = await mint()
    state = freshState()
    const result = await claim(code, NONCE, TS_IP)
    expect(result.status).toBe(404)
    expect(result.json.reason).toBe('unknown_code')
    expect((await call('/api/pairing/status', { token: true })).json.bootId).not.toBe(bootId)
  })

  it('caps the claim body at 1 KB and refuses junk with bad_request', async () => {
    await mint()
    const big = await call('/api/pairing/claim', { method: 'POST', ip: TS_IP, raw: JSON.stringify({ code: 'A'.repeat(2000), nonce: NONCE }) })
    expect(big.json.reason).toBe('bad_request')
    const junk = await call('/api/pairing/claim', { method: 'POST', ip: TS_IP, raw: '{not json' })
    expect(junk.status).toBe(400)
    expect(junk.json.reason).toBe('bad_request')
    const noNonce = await call('/api/pairing/claim', { method: 'POST', ip: TS_IP, body: { code: 'ZZZZZZZZ' } })
    expect(noNonce.json.reason).toBe('bad_request')
  })
})

describe('status and decision', () => {
  it.each([
    ['GET', '/api/pairing/status', undefined],
    ['POST', '/api/pairing/decision', { nonce: NONCE, allow: true }],
  ])('%s %s refuses a non-loopback socket with the token, and 401s without it', async (method, path, body) => {
    const remote = await call(path, { method, token: true, ip: TS_IP, body })
    expect(remote.status).toBe(403)
    expect(remote.json.reason).toBe('not_loopback')
    expect((await call(path, { method, body })).status).toBe(401)
  })

  it('status reports the contract fields', async () => {
    const minted = await mint()
    const status = (await call('/api/pairing/status', { token: true })).json
    expect(Object.keys(status).sort()).toEqual(['bootId', 'code', 'firstAuthAfterClaimAt', 'lanArmedUntil', 'lastClaim', 'pending'])
    expect(status.code).toEqual({ display: minted.display, expiresAt: minted.expiresAt, state: 'active' })
    expect(status.pending).toBeNull()
    expect(status.lastClaim).toBeNull()
  })

  it('decision on an unknown nonce is unknown_code', async () => {
    await mint()
    const result = await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    expect(result.status).toBe(404)
    expect(result.json.reason).toBe('unknown_code')
  })
})

describe('drain and the mutation lease', () => {
  it('pairing mutations never reach the mutation lease', async () => {
    const { code } = await mint()
    await claim(code, NONCE, TS_IP)
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    expect(leaseHits).toBe(0)
    // Sanity: the stand-in lease does refuse an ordinary mutation.
    expect((await call('/api/other-mutation', { method: 'POST', token: true, body: {} })).status).toBe(503)
    expect(leaseHits).toBe(1)
  })

  it('still serves the poll while draining, so an allowed token reaches the phone', async () => {
    const { code } = await mint()
    await claim(code, NONCE, TS_IP)
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    draining = true // the update gate closes between Allow and the next poll
    const polled = await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    expect(polled.status).toBe(200)
    expect(polled.json).toEqual({ state: 'allowed', token: TOKEN, serverName: 'Test-Mac' })
    expect((await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })).json).toEqual({ state: 'delivered', serverName: 'Test-Mac' })
  })

  it.each([
    ['POST', '/api/pairing/code', true, undefined],
    ['POST', '/api/pairing/claim', false, TS_IP],
    ['GET', '/api/pairing/status', true, undefined],
    ['POST', '/api/pairing/decision', true, undefined],
  ])('%s %s answers 503 draining while shutting down', async (method, path, token, ip) => {
    draining = true
    const result = await call(path, { method, token, ip, body: method === 'POST' ? { code: 'ZZZZZZZZ', nonce: NONCE, allow: true } : undefined })
    expect(result.status).toBe(503)
    expect(result.json.reason).toBe('draining')
  })
})

describe('logging', () => {
  let lines: string[] = []
  beforeEach(() => {
    lines = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    }
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('never writes the code, nonce, token or QR text to any console level', async () => {
    const minted = await mint({ allowLan: true })
    await claim('ZZZZZZZZ', NONCE_2, TS_IP_2)
    await claim(minted.display, NONCE, TS_IP)
    await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    await call('/api/pairing/decision', { method: 'POST', token: true, body: { nonce: NONCE, allow: true } })
    await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP_2 })
    await call(`/api/pairing/claim/${NONCE}`, { ip: TS_IP })
    await call('/api/models', { ip: TS_IP, token: true })
    const joined = lines.join('\n')
    expect(lines.length).toBeGreaterThanOrEqual(4)
    for (const secret of [minted.code, minted.display, minted.qr, NONCE, NONCE_2, 'ZZZZZZZZ', TOKEN]) {
      expect(joined).not.toContain(secret)
    }
    expect(joined).toContain(`ip=${TS_IP}`)
  })
})

describe('index.ts wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'index.ts'), 'utf8')
  it('mounts pairing after the token gate and before the mutation lease and the 10 MB parser', () => {
    const gate = source.indexOf("app.use('/api', requireApiToken(API_TOKEN")
    const pairing = source.indexOf("app.use('/api', createPairingRouter(")
    const lease = source.indexOf("app.use('/api', (req, res, next) => {\n  if (req.method === 'GET'")
    const parser = source.indexOf("app.use(express.json({ limit: '10mb' }))")
    expect(gate).toBeGreaterThan(0)
    expect(pairing).toBeGreaterThan(gate)
    expect(lease).toBeGreaterThan(pairing)
    expect(parser).toBeGreaterThan(lease)
    expect(source.match(/createPairingRouter\(/g)).toHaveLength(1)
  })
  it('wires firstAuthAfterClaimAt to the socket address and drain to shutdown plus the gate', () => {
    expect(source).toContain('onAuthenticated: req => pairingState.noteAuthenticated(req.socket?.remoteAddress)')
    expect(source).toContain('isDraining: () => gracefulShutdownStarted || !maintenanceAdmissionsOpen()')
    expect(source).not.toMatch(/trust proxy/)
  })
})
