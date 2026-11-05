// Open COS on the web, from the COS Glasses app: POST /api/web-session/phone-link.
// The phone asks with its pairing token, copies the returned link and pastes it into Safari,
// where it signs in once, within 2 minutes. These run the real router behind the real token gate.
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireApiToken } from '../lib/api-auth.js'
import { WebDeviceCodeStore, WebHandoffStore, WEB_HANDOFF_TTL_MS } from '../lib/web-session-auth.js'
import { isReadOnlyApiPost } from '../lib/work-search.js'
import {
  createWebControlRouter,
  isPhoneLinkSocketAllowed,
  WebPhoneLinkLimiter,
  WEB_PHONE_LINK_MAX_PER_WINDOW,
  WEB_PHONE_LINK_WINDOW_MS,
  type WebControlRouterDeps,
} from './web-control.js'

const API_TOKEN = 'test_secret_token_phone_link_42'
const DNS = 'ukaoma-mac-studio.tail38457f.ts.net'
const TAIL_IP = '100.108.149.114'

interface Harness {
  base: string
  logs: string[]
  close: () => Promise<void>
}

const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
  vi.restoreAllMocks()
})

async function start(overrides: Partial<WebControlRouterDeps> = {}): Promise<Harness> {
  const logs: string[] = []
  const app = express()
  let port = 0
  app.use('/api', requireApiToken(API_TOKEN, { selfDnsName: () => DNS, allowedPorts: () => [port] }))
  app.use('/api', createWebControlRouter({
    apiToken: () => API_TOKEN,
    port: () => port,
    publicPort: () => 3141,
    selfDnsName: () => DNS,
    tailnetIpv4: () => TAIL_IP,
    log: line => { logs.push(line) },
    ...overrides,
  }))
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as { port: number }).port
  const h: Harness = {
    base: `http://127.0.0.1:${port}/api`,
    logs,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
  open.push(h)
  return h
}

type Body = Record<string, any>
async function phoneLink(h: Harness, headers: Record<string, string> = { 'X-COS-Token': API_TOKEN }): Promise<{ status: number; body: Body; headers: Headers }> {
  const res = await fetch(`${h.base}/web-session/phone-link`, { method: 'POST', headers })
  let body: Body = {}
  try { body = await res.json() as Body } catch { body = {} }
  return { status: res.status, body, headers: res.headers }
}

function ticketOf(url: string): string {
  return new URL(url).searchParams.get('handoff') ?? ''
}

async function login(h: Harness, body: Record<string, string>): Promise<Response> {
  return fetch(`${h.base}/web-session/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/web-session/phone-link', () => {
  it('answers 401 without the pairing token, and with a wrong one', async () => {
    const h = await start()
    expect((await phoneLink(h, {})).status).toBe(401)
    const wrong = await phoneLink(h, { 'X-COS-Token': API_TOKEN + 'x' })
    expect(wrong.status).toBe(401)
  })

  it('refuses a browser signed in with the cookie: only the glasses token mints a link', async () => {
    const h = await start()
    const signedIn = await login(h, { token: API_TOKEN })
    expect(signedIn.status).toBe(200)
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie).toContain('cos_web_session=')
    const origin = new URL(h.base).origin
    // The cookie alone passes the global gate (it is a valid browser session), so this proves the route's own check.
    const viaCookie = await phoneLink(h, { Cookie: cookie, 'X-COS-Web': '1', Origin: origin })
    expect(viaCookie.status).toBe(401)
    expect(viaCookie.body).toMatchObject({ reason: 'pairing_token_required' })
    const deviceCode = await fetch(`${h.base}/web-session/device-code`, { method: 'POST', headers: { Cookie: cookie, 'X-COS-Web': '1', Origin: origin } })
    expect(deviceCode.status).toBe(200) // the same cookie does pass the gate elsewhere
  })

  it('returns the tailnet name link, a sign-in code and its address, private and unstored', async () => {
    const h = await start()
    const before = Date.now()
    const out = await phoneLink(h)
    expect(out.status).toBe(200)
    expect(out.headers.get('cache-control')).toBe('private, no-store')
    const ticket = ticketOf(out.body.url)
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(out.body).toEqual({
      ok: true,
      url: `http://${DNS}:3141/control?handoff=${ticket}`,
      expiresAt: expect.any(String),
      code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/),
      codeAddress: `http://${DNS}:3141/control`,
      codeExpiresAt: expect.any(String),
    })
    const ttl = Date.parse(out.body.expiresAt) - before
    expect(ttl).toBeGreaterThan(WEB_HANDOFF_TTL_MS - 5_000)
    expect(ttl).toBeLessThanOrEqual(WEB_HANDOFF_TTL_MS + 1_000)
  })

  it('falls back to the Tailscale IP link when the name is unknown, and mints nothing without either', async () => {
    let name: string | null = null
    let ip: string | null = TAIL_IP
    const handoffs = new WebHandoffStore()
    const mint = vi.spyOn(handoffs, 'mint')
    const h = await start({ selfDnsName: () => name, tailnetIpv4: () => ip, handoffStore: handoffs })
    const viaIp = await phoneLink(h)
    expect(viaIp.status).toBe(200)
    expect(viaIp.body.url).toBe(`http://${TAIL_IP}:3141/control?handoff=${ticketOf(viaIp.body.url)}`)
    expect(viaIp.body.codeAddress).toBe(`http://${TAIL_IP}:3141/control`)
    expect(mint).toHaveBeenCalledTimes(1)

    ip = null
    const none = await phoneLink(h)
    expect(none.status).toBe(503)
    expect(none.body).toMatchObject({ ok: false, error: 'no_tailnet_address' })
    expect(none.body.url).toBeUndefined()
    expect(mint).toHaveBeenCalledTimes(1)
    name = DNS
    expect((await phoneLink(h)).body.url).toContain(`http://${DNS}:3141/control?handoff=`)
  })

  it('the link signs in once; the code signs in once', async () => {
    const h = await start()
    const out = await phoneLink(h)
    const ticket = ticketOf(out.body.url)
    const first = await login(h, { handoff: ticket })
    expect(first.status).toBe(200)
    expect(first.headers.get('set-cookie') ?? '').toContain('cos_web_session=')
    const again = await login(h, { handoff: ticket })
    expect(again.status).toBe(401)
    expect(await again.json()).toMatchObject({ reason: 'handoff_expired' })

    expect((await login(h, { code: out.body.code })).status).toBe(200)
    expect((await login(h, { code: out.body.code })).status).toBe(401)
  })

  it('the link stops working after 2 minutes', async () => {
    let now = 1_800_000_000_000
    const h = await start({ handoffStore: new WebHandoffStore(() => now), deviceCodeStore: new WebDeviceCodeStore(() => now) })
    const fresh = await phoneLink(h)
    const stale = await phoneLink(h)
    now += WEB_HANDOFF_TTL_MS - 1
    expect((await login(h, { handoff: ticketOf(fresh.body.url) })).status).toBe(200)
    now += 2
    const late = await login(h, { handoff: ticketOf(stale.body.url) })
    expect(late.status).toBe(401)
    expect(await late.json()).toMatchObject({ reason: 'handoff_expired' })
  })

  it('allows 5 links a minute, then answers 429 with Retry-After until the minute ends', async () => {
    let now = 1_800_000_000_000
    const h = await start({ phoneLinkLimiter: new WebPhoneLinkLimiter(() => now) })
    for (let i = 0; i < WEB_PHONE_LINK_MAX_PER_WINDOW; i++) {
      expect((await phoneLink(h)).status).toBe(200)
      now += 1_000
    }
    const sixth = await phoneLink(h)
    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('retry-after')).toBe('55')
    expect(sixth.body).toMatchObject({ ok: false, error: 'too_many_links', retryAfterS: 55 })
    expect(sixth.body.url).toBeUndefined()
    now += 54_000
    expect((await phoneLink(h)).status).toBe(429)
    now += 1_000
    expect((await phoneLink(h)).status).toBe(200)
  })

  it('refuses a caller behind a proxy, and admits only this Mac, Tailscale and home networks', async () => {
    const h = await start()
    const post = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const u = new URL(`${h.base}/web-session/phone-link`)
      const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(await post({ 'X-COS-Token': API_TOKEN, 'X-Forwarded-For': '203.0.113.9' })).toBe(403)
    expect(await post({ 'X-COS-Token': API_TOKEN, 'X-Forwarded-Host': 'evil.example' })).toBe(403)
    expect(await post({ 'X-COS-Token': API_TOKEN })).toBe(200)

    for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.81.195.27', 'fd7a:115c:a1e0::1', '192.168.1.20', '10.0.0.4', '172.16.5.5']) {
      expect(isPhoneLinkSocketAllowed(ok), ok).toBe(true)
    }
    for (const bad of ['', '8.8.8.8', '203.0.113.9', '172.32.0.1', '100.128.0.1', '::ffff:8.8.8.8']) {
      expect(isPhoneLinkSocketAllowed(bad), bad).toBe(false)
    }
    expect(isPhoneLinkSocketAllowed(undefined)).toBe(false)
    expect(isPhoneLinkSocketAllowed('100.81.195.27', { 'x-forwarded-for': '1.2.3.4' })).toBe(false)
  })

  it('never logs the ticket, the link or the code, on any path', async () => {
    const consoleLines: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')) })
    }
    let now = 1_800_000_000_000
    const h = await start({ phoneLinkLimiter: new WebPhoneLinkLimiter(() => now, 2) })
    const minted = [await phoneLink(h), await phoneLink(h)]
    const refused = await phoneLink(h)
    expect(refused.status).toBe(429)
    for (const m of minted) {
      expect((await login(h, { handoff: ticketOf(m.body.url) })).status).toBe(200)
      expect((await login(h, { handoff: ticketOf(m.body.url) })).status).toBe(401)
    }
    expect(h.logs.filter(l => l.startsWith('[web-phone-link] minted via=name ip=127.0.0.1'))).toHaveLength(2)
    expect(h.logs.some(l => l.startsWith('[web-phone-link] refused kind=rate_limited'))).toBe(true)
    const everything = [...h.logs, ...consoleLines].join('\n')
    for (const m of minted) {
      const ticket = ticketOf(m.body.url)
      const code: string = m.body.code
      for (const secret of [ticket, m.body.url, code, code.replace('-', ''), ticket.slice(0, 12)]) {
        expect(everything).not.toContain(secret)
      }
    }
  })

  it('never holds the mutation lease, like the other sign-in routes', () => {
    expect(isReadOnlyApiPost('POST', '/web-session/phone-link')).toBe(true)
  })
})

describe('WebPhoneLinkLimiter', () => {
  it('counts only admitted links and frees each slot one window after it was taken', () => {
    let now = 0
    const limiter = new WebPhoneLinkLimiter(() => now, 2, WEB_PHONE_LINK_WINDOW_MS)
    expect(limiter.take()).toBe(0)
    now = 30_000
    expect(limiter.take()).toBe(0)
    expect(limiter.take()).toBe(30)
    expect(limiter.take()).toBe(30)
    now = 60_000
    expect(limiter.take()).toBe(0)
    expect(limiter.take()).toBe(30)
    now = 90_000
    expect(limiter.take()).toBe(0)
  })
})

describe('Control Web drops the ticket from the address bar (web-control/app.js boot, executed)', () => {
  const appJs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web-control/app.js'), 'utf8')
  const boot = appJs.match(/ {2}function boot\(\) \{[\s\S]*?\n {2}\}\n/)?.[0]
  if (!boot) throw new Error('web-control/app.js no longer has boot()')

  function run(search: string) {
    const events: string[] = []
    const location = { search, pathname: '/control/', hash: '#activity' }
    const history = { replaceState: (_s: unknown, _t: string, url: string) => { events.push(`replace:${url}`); location.search = '' } }
    const api = (path: string, init?: { body?: Record<string, string> }) => {
      events.push(`api:${path}:${init?.body ? Object.keys(init.body).join(',') : ''}:search=${location.search}`)
      return new Promise(() => {})
    }
    new Function('location', 'history', 'document', 'api', 'showShell', 'showAuth', '$', `${boot}\nboot()`)(
      location, history, { title: 'COS' }, api, () => {}, () => {}, () => null,
    )
    return { events, location }
  }

  it('replaces the address before it signs in, so a later copy of the address bar shares nothing', () => {
    const { events, location } = run('?handoff=abcDEF123_-xyz0987654321')
    expect(events).toEqual(['replace:/control/#activity', 'api:/api/web-session/login:handoff:search='])
    expect(location.search).toBe('')
  })

  it('does the same for a code link, and leaves a plain address alone', () => {
    expect(run('?code=K7P3-QX9M').events[0]).toBe('replace:/control/#activity')
    expect(run('').events).toEqual(['api:/api/web-session/status::search='])
  })
})
