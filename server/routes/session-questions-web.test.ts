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
import { __resetClientLivenessForTests, lastQuestionsPollAt } from '../lib/client-liveness.js'
import { isWebSessionAuthorized, mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME } from '../lib/web-session-auth.js'
import { PERMISSION_BROKER_HOOK_PATH, createPermissionBrokerHookRouter, createSessionQuestionsRouter } from './permission-broker.js'
import { ASK_INPUT, Q1, Q2, permissionEnvelope } from '../lib/__fixtures__/permission-broker.js'

const API_TOKEN = 'api-tok-69912'
const HOOK_TOKEN = 'hook-tok-69912'

const servers: Server[] = []
const brokers: PermissionBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) b.stop()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
})

interface Harness { base: string; host: string; broker: PermissionBroker; cookie: string }

/** `web: false` leaves the cookie check out of the questions router, as 6.99.11 and earlier mounted it. */
async function start(opts: { web?: boolean } = {}): Promise<Harness> {
  __resetClientLivenessForTests()
  const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
  const broker = new PermissionBroker({
    now: () => Date.now(), mode: () => 'all', admissionsOpen: () => true, lastQuestionsPollAt,
    readDeskIdleSeconds: async () => 1_000, deskIdleSeconds: () => 90, timeoutMs: () => 4_000,
    signals: brokerSignalSink(store), pollMs: 25, log: () => {},
  })
  brokers.push(broker)
  wirePermissionBrokerToSignals(broker, store)
  const app = express()
  app.use(createPermissionBrokerHookRouter({ hookToken: () => HOOK_TOKEN, broker }))
  app.use('/api', requireApiToken(API_TOKEN))
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', createSessionQuestionsRouter({
    broker,
    apiToken: () => API_TOKEN,
    ...(opts.web === false ? {} : { webSessionAuthorized: (req: express.Request) => isWebSessionAuthorized(req, API_TOKEN, { selfDnsName: null, allowedPorts: [] }) }),
  }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, broker, cookie: `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(API_TOKEN).value}` }
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
  it('the browser session reads the list; only ?client=web makes it a live client', async () => {
    const h = await start()
    for (const client of [null, 'phone', 'glasses', 'control', 'WEB']) {
      const r = await list(h, browser(h), client)
      expect(r.status, `client=${client}`).toBe(200)
      expect(r.body.items).toEqual([])
      expect(lastQuestionsPollAt(), `a cookie poll with client=${client} never counts`).toBeNull()
    }
    expect((await list(h, browser(h), 'web')).status).toBe(200)
    expect(lastQuestionsPollAt()).not.toBeNull()
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

  it('the questions router itself refuses a cookie it was not given a check for (the gate alone is not enough)', async () => {
    const h = await start({ web: false })
    // The /api gate passes the browser session; the router, built without webSessionAuthorized, still refuses.
    expect((await list(h, browser(h), 'web')).status).toBe(401)
    expect(lastQuestionsPollAt()).toBeNull()
  })

  it('a question waits for the web, and the web answers it through the gate with its session', async () => {
    const h = await start()
    // Nobody is polling: the Mac's own dialog, at once.
    const first = await fetch(`${h.base}${PERMISSION_BROKER_HOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-hook-token': HOOK_TOKEN }, body: JSON.stringify(permissionEnvelope('AskUserQuestion', ASK_INPUT)) })
    expect(await first.json()).toEqual({})
    // The page shows the cards: it polls as web, and the next question is held for it.
    expect((await list(h, browser(h), 'web')).status).toBe(200)
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
  })

  it('index.ts hands the router the same cookie check the /api gate runs', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(index).toContain("app.use('/api', createSessionQuestionsRouter({ broker: permissionBroker, apiToken: () => API_TOKEN, webSessionAuthorized: webSessionCookieAuthorized }))")
    const fn = index.slice(index.indexOf('const webSessionCookieAuthorized'), index.indexOf("app.use('/api', createSessionQuestionsRouter("))
    expect(fn).toContain('isWebSessionAuthorized(req, API_TOKEN, {')
    expect(fn).toContain('selfDnsName: tailnetSelf.currentSelfDnsName()')
    expect(fn).toContain('allowedPorts: [PORT, HTTPS_PORT]')
  })
})
