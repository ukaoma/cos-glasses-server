// 6.99.12: COS Control Web reads and answers session questions with its browser session (the signed
// `cos_web_session` cookie), wired as index.ts wires it: the hook's door, the /api gate, the global parser,
// then the questions router with the same cookie check the gate runs. Real sockets, a real PermissionBroker
// and the REAL liveness module, so "counts as a live client" is read off the broker, not off a spy.
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { requireApiToken } from '../lib/api-auth.js'
import { PermissionBroker, brokerSignalSink, questionHookOutput, wirePermissionBrokerToSignals } from '../lib/permission-broker.js'
import { SessionSignalStore } from '../lib/session-signal-store.js'
import { __resetClientLivenessForTests, lastHoldQuestionsPollAt, lastLegacyQuestionsPollAt, lastQuestionsPollAt, presenceAgeMs, webPresenceAgeMs } from '../lib/client-liveness.js'
import { isWebSessionAuthorized, mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME } from '../lib/web-session-auth.js'
import { PERMISSION_BROKER_HOOK_PATH, createPermissionBrokerHookRouter, createSessionQuestionsRouter, requestFromThisMac, selfAddressesFromInterfaces } from './permission-broker.js'
import { ASK_INPUT, Q1, Q2, permissionEnvelope } from '../lib/__fixtures__/permission-broker.js'

const API_TOKEN = 'api-tok-69912'
const HOOK_TOKEN = 'hook-tok-69912'

const servers: Server[] = []
const brokers: PermissionBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) b.stop()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
})

interface Harness { base: string; host: string; broker: PermissionBroker; cookie: string; lines: string[] }

/**
 * `web: false` leaves the cookie check out of the questions router, as 6.99.11 and earlier mounted it.
 * `away: true` wires the broker as index.ts does for the away hold (6.60.0, 6.99.26): the real liveness
 * module's presence readers, a 10 minute hold, and a hook that waits 630 s. `desk` is the desk's idle seconds.
 */
async function start(opts: { web?: boolean; gate?: boolean; away?: boolean; awayHoldMs?: number; hookTimeoutS?: number; desk?: () => number; webSwitch?: () => boolean; macItself?: boolean; selfAddresses?: readonly string[] } = {}): Promise<Harness> {
  __resetClientLivenessForTests()
  const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
  const desk = opts.desk ?? (() => 1_000)
  const lines: string[] = []
  const broker = new PermissionBroker({
    now: () => Date.now(), mode: () => 'all', admissionsOpen: () => true, lastQuestionsPollAt,
    readDeskIdleSeconds: async () => desk(), deskIdleSeconds: () => 90, timeoutMs: () => 4_000,
    ...(opts.away ? {
      lastLegacyPollAt: lastLegacyQuestionsPollAt, lastHoldPollAt: lastHoldQuestionsPollAt,
      presenceAgeMs: () => presenceAgeMs(), webPresenceAgeMs: () => webPresenceAgeMs(),
      awayHoldMs: () => opts.awayHoldMs ?? 600_000, installedHookTimeoutS: () => opts.hookTimeoutS ?? 630, awayRecentClientMs: () => 1_800_000,
      ...(opts.webSwitch ? { webAwayHold: opts.webSwitch } : {}),
    } : {}),
    signals: brokerSignalSink(store), pollMs: 25, log: (line: string) => { lines.push(line) },
  })
  brokers.push(broker)
  wirePermissionBrokerToSignals(broker, store)
  const app = express()
  app.use(createPermissionBrokerHookRouter({ hookToken: () => HOOK_TOKEN, broker }))
  if (opts.gate !== false) app.use('/api', requireApiToken(API_TOKEN))
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', createSessionQuestionsRouter({
    broker,
    apiToken: () => API_TOKEN,
    ...(opts.web === false ? {} : { webSessionAuthorized: (req: express.Request) => isWebSessionAuthorized(req, API_TOKEN, { selfDnsName: null, allowedPorts: [] }) }),
    // Every test socket is loopback, which is the Mac itself (QA round 1). The away tests stand in for the phone; the
    // Mac-itself tests keep the production check.
    ...(opts.away && !opts.macItself ? { fromThisMac: () => false } : {}),
    // W12: the production check with a fixed list of the Mac's own addresses, so a Serve hop can be told apart.
    ...(opts.away && opts.macItself && opts.selfAddresses ? { fromThisMac: (req: express.Request) => requestFromThisMac(req, () => opts.selfAddresses!) } : {}),
  }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, broker, cookie: `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(API_TOKEN).value}`, lines }
}

async function list(h: Harness, headers: Record<string, string>, client: string | null) {
  const res = await fetch(`${h.base}/api/session-questions${client === null ? '' : `?client=${client}`}`, { headers })
  return { status: res.status, body: await res.json() as { items: Array<Record<string, any>>; enabled: boolean } }
}
const browser = (h: Harness) => ({ cookie: h.cookie })
/** A browser write: the cookie, the CSRF header, and an Origin naming this very host (lib/web-session-auth.ts). */
const browserWrite = (h: Harness) => ({ cookie: h.cookie, 'x-cos-web': '1', origin: `http://${h.host}`, 'content-type': 'application/json' })

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`condition not met in ${ms} ms: ${JSON.stringify(v).slice(0, 300)}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('GET /api/session-questions with the COS Control Web session (6.99.12)', () => {
  it('the browser session reads the list and never counts as a live client, even as ?client=web (6.99.13)', async () => {
    const h = await start()
    for (const client of [null, 'phone', 'glasses', 'control', 'WEB', 'web']) {
      const r = await list(h, browser(h), client)
      expect(r.status, `client=${client}`).toBe(200)
      expect(r.body.items).toEqual([])
      expect(lastQuestionsPollAt(), `a cookie poll with client=${client} never counts`).toBeNull()
    }
  })

  it('the token naming web never counts; the token naming phone still does', async () => {
    const h = await start()
    expect((await list(h, { 'x-cos-token': API_TOKEN }, 'web')).status).toBe(200)
    expect(lastQuestionsPollAt()).toBeNull()
    expect((await list(h, { 'x-cos-token': API_TOKEN }, 'phone')).status).toBe(200)
    expect(lastQuestionsPollAt()).not.toBeNull()
  })

  it('the hook token opens nothing, alone or beside a forged or stale cookie, and never counts', async () => {
    const h = await start()
    const forged = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue('not-the-token').value}`
    const expired = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(API_TOKEN, Date.now() - 10 * 24 * 3_600_000).value}`
    for (const headers of [
      { 'x-cos-hook-token': HOOK_TOKEN },
      { 'x-cos-token': HOOK_TOKEN },
      { cookie: forged },
      { cookie: expired },
      { cookie: forged, 'x-cos-hook-token': HOOK_TOKEN },
      {},
    ] as Array<Record<string, string>>) {
      const r = await list(h, headers, 'web')
      expect(r.status, JSON.stringify(Object.keys(headers))).toBe(401)
    }
    expect(lastQuestionsPollAt()).toBeNull()
  })

  it('with no /api gate in front, the router itself refuses a forged, stale or missing session and the hook token', async () => {
    const h = await start({ gate: false })
    const forged = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue('not-the-token').value}`
    const expired = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(API_TOKEN, Date.now() - 10 * 24 * 3_600_000).value}`
    for (const headers of [{ cookie: forged }, { cookie: expired }, { 'x-cos-hook-token': HOOK_TOKEN }, { 'x-cos-token': HOOK_TOKEN }, {}] as Array<Record<string, string>>) {
      expect((await list(h, headers, 'web')).status, JSON.stringify(Object.keys(headers))).toBe(401)
    }
    expect(lastQuestionsPollAt()).toBeNull()
    expect((await list(h, browser(h), 'web')).status).toBe(200)
    expect(lastQuestionsPollAt()).toBeNull()
  })

  it('the questions router itself refuses a cookie it was not given a check for (the gate alone is not enough)', async () => {
    const h = await start({ web: false })
    // The /api gate passes the browser session; the router, built without webSessionAuthorized, still refuses.
    expect((await list(h, browser(h), 'web')).status).toBe(401)
    expect(lastQuestionsPollAt()).toBeNull()
  })

  it('an open web tab never holds a question from the Mac, and the web answers one the phone holds (6.99.13)', async () => {
    const h = await start()
    // The page shows the cards and polls as web: the Mac's own dialog still comes at once (option B).
    expect((await list(h, browser(h), 'web')).status).toBe(200)
    const first = await fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, body: JSON.stringify(permissionEnvelope('AskUserQuestion', ASK_INPUT)) })
    expect(await first.json()).toEqual({})
    // The phone polls: the next question is held, and the web answers it with its session.
    expect((await list(h, { 'x-cos-token': API_TOKEN }, 'phone')).status).toBe(200)
    const hook = fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, body: JSON.stringify(permissionEnvelope('AskUserQuestion', ASK_INPUT)) })
      .then(r => r.json())
    const item = (await until(() => list(h, browser(h), 'web'), l => l.body.items.length === 1)).body.items[0]!
    expect(item).toMatchObject({ kind: 'question', answerable: true })
    // Without the CSRF header the browser's write is refused by the gate.
    const noCsrf = await fetch(`${h.base}/api/session-questions/${item.id}/answer`, { method: 'POST', headers: { cookie: h.cookie, 'content-type': 'application/json' }, body: '{}' })
    expect(noCsrf.status).toBe(401)
    const body = { clientAnswerId: 'gw_web1', answers: [{ labels: ['Publish'] }, { labels: ['Blue'] }] }
    const ans = await fetch(`${h.base}/api/session-questions/${item.id}/answer`, { method: 'POST', headers: browserWrite(h), body: JSON.stringify(body) })
    expect(ans.status).toBe(200)
    const answers = { [Q1]: ['Publish'], [Q2]: ['Blue'] }
    expect(await hook).toEqual(questionHookOutput(ASK_INPUT, answers))
    // 6.99.27: the log names the web as the answerer, never the glasses.
    expect(h.lines.filter(l => /_won /.test(l))).toEqual([`[permission-broker] web_won ${item.id}`])
  })

  it('6.99.27: an answer with the API token (the Even app) still logs glasses_won', async () => {
    const h = await start()
    expect((await list(h, { 'x-cos-token': API_TOKEN }, 'phone')).status).toBe(200)
    const hook = fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, body: JSON.stringify(permissionEnvelope('AskUserQuestion', ASK_INPUT)) }).then(r => r.json())
    const item = (await until(() => list(h, { 'x-cos-token': API_TOKEN }, 'phone'), l => l.body.items.length === 1)).body.items[0]!
    const ans = await fetch(`${h.base}/api/session-questions/${item.id}/answer`, { method: 'POST', headers: { 'x-cos-token': API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ clientAnswerId: 'gw_app1', answers: [{ labels: ['Publish'] }, { labels: ['Blue'] }] }) })
    expect(ans.status).toBe(200)
    await hook
    expect(h.lines.filter(l => /_won /.test(l))).toEqual([`[permission-broker] glasses_won ${item.id}`])
  })

  it('index.ts hands the router the same cookie check the /api gate runs', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(index).toContain("app.use('/api', createSessionQuestionsRouter({ broker: permissionBroker, apiToken: () => API_TOKEN, webSessionAuthorized: webSessionCookieAuthorized }))")
    const fn = index.slice(index.indexOf('const webSessionCookieAuthorized'), index.indexOf("app.use('/api', createSessionQuestionsRouter("))
    expect(fn).toContain('isWebSessionAuthorized(req, API_TOKEN, {')
    expect(fn).toContain('selfDnsName: tailnetSelf.currentSelfDnsName()')
    expect(fn).toContain('allowedPorts: [PORT, HTTPS_PORT]')
  })

  it('index.ts gives the broker the web touch, beside the wearer presence (6.99.26)', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const deps = index.slice(index.indexOf('const permissionBroker = new PermissionBroker({'), index.indexOf('stillWaitingAtMac:'))
    expect(deps).toContain('  presenceAgeMs: () => presenceAgeMs(),\n  webPresenceAgeMs: () => webPresenceAgeMs(),\n')
  })
})

// 6.99.26 (Miles 11/07, "Away rule, like phone"): COS Control Web joins the away hold the way the phone does, and
// never through the plain liveness. Real route, real broker, real liveness module.
describe('COS Control Web and the away hold (6.99.26)', () => {
  const hookPost = (h: Harness, extra: Record<string, unknown> = {}) => fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN },
    body: JSON.stringify({ ...permissionEnvelope('AskUserQuestion', ASK_INPUT), hookWaitS: 630, ...extra }),
  }).then(r => r.json())
  /** The hook's answer if it comes within `ms`, else the string 'held'. */
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'held'>(r => setTimeout(() => r('held'), ms))])
  const webPoll = (h: Harness, query: string) => fetch(`${h.base}/api/session-questions?${query}`, { headers: browser(h) }).then(async r => ({ status: r.status, body: await r.json() as { items: Array<Record<string, any>> } }))
  const touchedAgo = (ms: number) => `client=web&hold=1&presenceAgeMs=${ms}`

  it('at the desk with the web live and just touched, the question goes to the Mac at once, stamped or not', async () => {
    const h = await start({ away: true, desk: () => 5 })
    expect((await webPoll(h, touchedAgo(1_000))).status).toBe(200)
    expect(webPresenceAgeMs()).not.toBeNull()
    for (const extra of [{}, { askHold: 1 }]) {
      const t0 = Date.now()
      expect(await hookPost(h, extra), JSON.stringify(extra)).toEqual({})
      expect(Date.now() - t0).toBeLessThan(1_000)
    }
    expect(h.broker.pendingCount()).toBe(0)
  })

  it('away, a web-only stamped question is held for the web; the desk coming back hands it to the Mac within a poll', async () => {
    let idle = 1_000
    const h = await start({ away: true, desk: () => idle })
    expect((await webPoll(h, touchedAgo(2_000))).status).toBe(200)
    const hook = hookPost(h, { askHold: 1 })
    const item = (await until(() => webPoll(h, touchedAgo(2_000)), l => l.body.items.length === 1)).body.items[0]!
    expect(item).toMatchObject({ kind: 'question', answerable: true, awayHold: true })
    idle = 1
    expect(await hook).toEqual({})
    const settled = (await webPoll(h, touchedAgo(2_000))).body as unknown as { settled: Array<Record<string, unknown>> }
    expect(settled.settled[0]).toMatchObject({ resolution: 'handed_to_desk', waitingAtMac: true })
  })

  it('Control Web open on the Mac itself (loopback) is the desk: its touch records nothing and holds nothing', async () => {
    const h = await start({ away: true, macItself: true })
    expect((await webPoll(h, touchedAgo(1_000))).status).toBe(200)
    expect(webPresenceAgeMs()).toBeNull()
    expect(await hookPost(h)).toEqual({})
    expect(await hookPost(h, { askHold: 1 })).toEqual({})
  })

  it('W12 pin: today a `tailscale serve` hop carries no web session at all (review W4), so it can record no touch, desk or away', async () => {
    // isWebControlSocketAllowed refuses every proxied request, so the router answers 401 before requestFromThisMac is
    // asked. The reviewer's "stored as away" path is not reachable in 7.0.2; requestFromThisMac's Serve rule (unit tests
    // below) is what decides the day Control Web is admitted through Serve.
    const self = ['100.101.102.103', 'fd7a:115c:a1e0::1234', '192.168.1.20']
    for (const xff of ['100.101.102.103', 'fd7a:115c:a1e0::1234', '127.0.0.1', '100.64.0.9']) {
      const h = await start({ away: true, macItself: true, selfAddresses: self })
      const res = await fetch(`${h.base}/api/session-questions?${touchedAgo(1_000)}`, {
        headers: { ...browser(h), 'x-forwarded-for': xff, 'x-forwarded-host': 'mac.tail1234.ts.net', 'x-forwarded-proto': 'https', 'tailscale-user-login': 'miles@example.com' },
      })
      expect(res.status, xff).toBe(401)
      expect(webPresenceAgeMs(), xff).toBeNull()
      expect(await hookPost(h)).toEqual({})
    }
  })

  it('COS_WEB_AWAY_HOLD off: the touch is recorded but holds nothing', async () => {
    const h = await start({ away: true, webSwitch: () => false })
    expect((await webPoll(h, touchedAgo(1_000))).status).toBe(200)
    expect(webPresenceAgeMs()).not.toBeNull()
    expect(await hookPost(h)).toEqual({})
    expect(await hookPost(h, { askHold: 1 })).toEqual({})
  })

  it('away, with the web touched recently, the question is held and answered from the web', async () => {
    const h = await start({ away: true })
    expect((await webPoll(h, touchedAgo(5_000))).status).toBe(200)
    const hook = hookPost(h)
    const item = (await until(() => webPoll(h, touchedAgo(6_000)), l => l.body.items.length === 1)).body.items[0]!
    expect(item).toMatchObject({ kind: 'question', answerable: true, awayHold: true })
    // Held past the base timeout (4 s here): the away hold, not the plain broker hold.
    expect(Date.parse(item.deadlineAt) - Date.parse(item.createdAt)).toBeGreaterThan(60_000)
    const body = { clientAnswerId: 'gw_web_away', answers: [{ labels: ['Publish'] }, { labels: ['Blue'] }] }
    const ans = await fetch(`${h.base}/api/session-questions/${item.id}/answer`, { method: 'POST', headers: browserWrite(h), body: JSON.stringify(body) })
    expect(ans.status).toBe(200)
    expect(await hook).toEqual(questionHookOutput(ASK_INPUT, { [Q1]: ['Publish'], [Q2]: ['Blue'] }))
    // The web's touch never became a live client of any kind.
    expect([lastQuestionsPollAt(), lastLegacyQuestionsPollAt(), lastHoldQuestionsPollAt(), presenceAgeMs()]).toEqual([null, null, null, null])
  })

  it('away, with the web touched over 30 minutes ago, nothing is held, stamped or not', async () => {
    const h = await start({ away: true })
    expect((await webPoll(h, touchedAgo(31 * 60_000))).status).toBe(200)
    expect(webPresenceAgeMs()).toBeGreaterThan(30 * 60_000)
    expect(await hookPost(h)).toEqual({})
    expect(await hookPost(h, { askHold: 1 })).toEqual({})
    expect(h.broker.pendingCount()).toBe(0)
  })

  it('the web never holds through the plain liveness: no hold=1, no presence, the away hold off, or a short hook', async () => {
    for (const query of ['client=web', 'client=web&presenceAgeMs=1000', 'client=web&hold=1', 'client=web&hold=1&presenceAgeMs=-5', 'client=web&hold=1&presenceAgeMs=1.5', 'client=web&hold=1&presenceAgeMs=86400001']) {
      const h = await start({ away: true })
      expect((await webPoll(h, query)).status, query).toBe(200)
      expect(webPresenceAgeMs(), query).toBeNull()
      expect(await hookPost(h), query).toEqual({})
      expect(await hookPost(h, { askHold: 1 }), query).toEqual({})
    }
    // A recent touch with the away hold off, or before Install hooks (a hook that waits 130 s): nothing is held, as
    // with no client at all. The web counts for the away hold only.
    for (const opts of [{ awayHoldMs: 0 }, { hookTimeoutS: 130 }]) {
      const h = await start({ away: true, ...opts })
      expect((await webPoll(h, touchedAgo(1_000))).status).toBe(200)
      expect(webPresenceAgeMs()).not.toBeNull()
      expect(await hookPost(h), JSON.stringify(opts)).toEqual({})
      expect(h.broker.pendingCount()).toBe(0)
    }
    expect([lastQuestionsPollAt(), lastLegacyQuestionsPollAt(), lastHoldQuestionsPollAt(), presenceAgeMs()]).toEqual([null, null, null, null])
  })

  it('only the browser session naming web records a touch: never the token, never another client name', async () => {
    const h = await start({ away: true })
    expect((await fetch(`${h.base}/api/session-questions?${touchedAgo(1_000)}`, { headers: { 'x-cos-token': API_TOKEN } })).status).toBe(200)
    for (const client of ['phone', 'glasses', 'control', 'WEB']) {
      expect((await webPoll(h, `client=${client}&hold=1&presenceAgeMs=1000`)).status).toBe(200)
    }
    expect(webPresenceAgeMs()).toBeNull()
    expect(lastQuestionsPollAt()).toBeNull()
    // The refusals still come first: a forged session records nothing.
    const forged = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue('not-the-token').value}`
    expect((await fetch(`${h.base}/api/session-questions?${touchedAgo(1_000)}`, { headers: { cookie: forged } })).status).toBe(401)
    expect(webPresenceAgeMs()).toBeNull()
    expect(await hookPost(h)).toEqual({})
  })
})

describe('requestFromThisMac (QA round 1)', () => {
  const own = () => ['100.101.102.103', '192.168.1.20']
  const req = (remoteAddress: string, headers: Record<string, unknown> = {}) => ({ socket: { remoteAddress }, headers })
  it('loopback and the Mac\u2019s own addresses are the Mac; a peer or a proxied request is not', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.101.102.103', '::ffff:100.101.102.103', '192.168.1.20']) expect(requestFromThisMac(req(ip), own), ip).toBe(true)
    for (const ip of ['100.64.0.9', '::ffff:100.64.0.9', '192.168.1.21', '']) expect(requestFromThisMac(req(ip), own), ip).toBe(false)
    // A `tailscale serve` hop arrives on loopback for a remote peer: never the Mac.
    expect(requestFromThisMac(req('127.0.0.1', { 'tailscale-user-login': 'miles@example.com' }), own)).toBe(false)
    expect(requestFromThisMac(req('100.101.102.103', { 'x-forwarded-for': '100.64.0.9' }), own)).toBe(false)
    expect(requestFromThisMac(req('100.101.102.103'), () => { throw new Error('no interfaces') }), 'unreadable interfaces: only loopback is known').toBe(false)
    expect(requestFromThisMac({ socket: null }, own)).toBe(false)
  })

  it('W12: a `tailscale serve` hop from the Mac to itself is the Mac; nothing a remote device can send makes it so', () => {
    const self = () => ['100.101.102.103', 'fd7a:115c:a1e0::1234', '192.168.1.20']
    const serve = (xff: unknown, more: Record<string, unknown> = {}, socket = '127.0.0.1') => req(socket, {
      'x-forwarded-for': xff, 'x-forwarded-host': 'mac.tail1234.ts.net', 'x-forwarded-proto': 'https',
      'tailscale-user-login': 'miles@example.com', 'tailscale-user-name': 'Miles', ...more,
    })
    // The Mac to itself: its own tailnet address (IPv4, IPv4-mapped, IPv6 in either case) or loopback.
    for (const xff of ['100.101.102.103', '::ffff:100.101.102.103', 'fd7a:115c:a1e0::1234', 'FD7A:115C:A1E0::1234', '127.0.0.1', '::1', ' 100.101.102.103 ']) {
      expect(requestFromThisMac(serve(xff), self), xff).toBe(true)
    }
    // Spoofs and look-alikes.
    const away: Array<[string, Record<string, unknown>]> = [
      ['a remote peer', serve('100.64.0.9')],
      ['the Mac\u2019s LAN address is not a tailnet source', serve('192.168.1.20')],
      ['a list (an appending proxy kept a spoofed value)', serve('100.101.102.103, 100.64.0.9')],
      ['a list, spoof last', serve('100.64.0.9, 100.101.102.103')],
      ['two headers joined', serve(['100.101.102.103', '100.64.0.9'])],
      ['an array of one', serve(['100.101.102.103'])],
      ['empty', serve('')],
      ['garbage', serve('mac.tail1234.ts.net')],
      ['loopback first in a list', serve('127.0.0.1, 100.64.0.9')],
      ['loopback first, space separated', serve('127.0.0.1 100.64.0.9')],
      ['a loopback-looking name', serve('127.evil.example')],
      ['a spoofed header straight to 3141 from a peer', serve('100.101.102.103', {}, '100.64.0.9')],
      ['a spoofed header from the Mac\u2019s own tailnet socket is not a Serve hop', serve('100.101.102.103', {}, '100.101.102.103')],
      ['Forwarded is not Serve', serve('100.101.102.103', { forwarded: 'for=100.101.102.103' })],
      ['X-Real-IP is not Serve', serve('100.101.102.103', { 'x-real-ip': '100.101.102.103' })],
      ['an unknown forwarding header', serve('100.101.102.103', { 'x-forwarded-port': '443' })],
      ['an unknown tailscale header', serve('100.101.102.103', { 'tailscale-funnel-request': '1' })],
      ['Serve headers without X-Forwarded-For', req('127.0.0.1', { 'tailscale-user-login': 'miles@example.com', 'x-forwarded-proto': 'https' })],
    ]
    for (const [why, r] of away) expect(requestFromThisMac(r as never, self), why).toBe(false)
    // An unreadable interface list knows no tailnet address; loopback still is the Mac.
    expect(requestFromThisMac(serve('100.101.102.103'), () => { throw new Error('no interfaces') })).toBe(false)
    expect(requestFromThisMac(serve('127.0.0.1'), () => { throw new Error('no interfaces') })).toBe(true)
  })

  it('W12: the default list of the Mac\u2019s own addresses includes its Tailscale IPv6', () => {
    const nets = {
      utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }, { address: 'fd7a:115c:a1e0::1234', family: 'IPv6', internal: false }],
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    }
    const own = selfAddressesFromInterfaces(nets as never)
    expect(own).toContain('100.101.102.103')
    expect(own).toContain('fd7a:115c:a1e0::1234')
    expect(own).toContain('192.168.1.20')
    expect(own).not.toContain('fe80::1')
    expect(own).not.toContain('::1')
  })

  it('index.ts gives the broker the web switch', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(index).toContain('  webAwayHold: () => webAwayHoldEnabled(process.env),\n')
  })
})

