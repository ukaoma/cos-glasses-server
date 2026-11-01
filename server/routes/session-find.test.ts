import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSessionFindRouter } from './session-find.js'
import { createDecisionProviderRouter } from './decision-provider.js'
import { createJevRouter } from './jev.js'
import { SessionFinder, clientCapacity, unavailableAnswer, type SessionFindAnswer, type SessionFindRequest } from '../lib/session-find.js'
import { SessionFindCollector } from '../lib/session-find-collect.js'
import { SessionFindAsker } from '../lib/session-find-ask.js'
import { SubqDecisionClient } from '../lib/decision-provider.js'
import { agentSessionRoots } from '../lib/agent-session-store.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { JevClient } from '../lib/jev.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
  vi.restoreAllMocks()
})

const answer: SessionFindAnswer = { available: true, reason: null, message: '', provider: 'jev', storesData: false, rows: [], asked: 0, reachedBack: null, skipped: 0, cached: false }

async function setup(find: (request: SessionFindRequest, signal: AbortSignal) => Promise<SessionFindAnswer> = async () => answer) {
  const finder = { find: vi.fn(find) }
  const app = express(); app.use(express.json())
  app.use('/api', (req, res, next) => req.header('X-COS-Token') === 't' ? next() : res.sendStatus(401))
  app.use('/api', createSessionFindRouter({ finder }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent-sessions/find`
  const post = (body: unknown, token = 't', signal?: AbortSignal) => fetch(url, { method: 'POST', headers: { 'X-COS-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  return { finder, post, url }
}
const good = { query: 'the tailscale thing', consentedProvider: 'jev', stage: 'first' }

describe('the route', () => {
  it('is authenticated by the /api mount, answers JSON and is not cached by clients', async () => {
    const s = await setup()
    expect((await s.post(good, 'wrong')).status).toBe(401)
    const res = await s.post(good)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.json()).toEqual(answer)
  })

  it('hands the finder exactly the three fields, with a missing consent as null', async () => {
    const s = await setup()
    await s.post({ query: 'a b c', stage: 'full' })
    await s.post({ query: 'a b c', consentedProvider: 'subq', stage: 'first' })
    expect(s.finder.find.mock.calls.map(c => c[0])).toEqual([{ query: 'a b c', consentedProvider: null, stage: 'full' }, { query: 'a b c', consentedProvider: 'subq', stage: 'first' }])
  })

  it('refuses a malformed body with 400 and never calls the finder', async () => {
    const s = await setup()
    const bad: unknown[] = [{}, [], { ...good, query: 7 }, { ...good, stage: 'later' }, { query: 'x y z', consentedProvider: 'jev' }, { ...good, consentedProvider: 'openai' },
      { ...good, consentedProvider: true }, { ...good, extra: 'text a client chose' }, { ...good, query: 'x'.repeat(2_001) }, { ...good, sessions: ['client supplied'] }, { ...good, ids: [1] }]
    for (const body of bad) {
      const res = await s.post(body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect((await res.json()).error.code).toBe('invalid_find_request')
    }
    expect(s.finder.find).not.toHaveBeenCalled()
  })

  it('passes an unavailable answer through as 200 so Control keeps its word search', async () => {
    const s = await setup(async () => unavailableAnswer('consent_required', 'subq'))
    const res = await s.post({ ...good, consentedProvider: null })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ available: false, reason: 'consent_required', provider: 'subq', storesData: true, rows: [], asked: 0, reachedBack: null, skipped: 0, cached: false })
  })

  it('answers 503 with fixed words when the finder throws, and logs no query', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const s = await setup(async request => { throw new Error(`could not read for ${request.query}`) })
    const res = await s.post({ ...good, query: 'a particular private phrase' })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('session_find_unavailable')
    expect(error.mock.calls.flat().join(' ')).toBe('[session-find] search failed')
  })

  it('stops the search when the connection closes before the answer, and says nothing', async () => {
    let seen: AbortSignal | undefined
    let release!: (a: SessionFindAnswer) => void
    const s = await setup((_request, signal) => { seen = signal; return new Promise<SessionFindAnswer>(r => { release = r }) })
    const gone = new AbortController()
    const pending = s.post(good, 't', gone.signal).catch(e => e)
    await vi.waitFor(() => expect(s.finder.find).toHaveBeenCalled())
    expect(seen!.aborted).toBe(false)
    gone.abort()
    await vi.waitFor(() => expect(seen!.aborted).toBe(true))
    release(answer)
    expect(((await pending) as Error).name).toBe('AbortError')
  })

  it('does not treat a finished answer as a closed connection', async () => {
    let seen: AbortSignal | undefined
    const s = await setup(async (_request, signal) => { seen = signal; return answer })
    await (await s.post(good)).json()
    await new Promise(r => setTimeout(r, 30))
    expect(seen!.aborted).toBe(false)
  })

  it('stays silent when the finder reports that the caller left', async () => {
    const s = await setup(async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e })
    const abortedFetch = await Promise.race([s.post(good).then(r => r.status), new Promise(r => setTimeout(() => r('no answer'), 150))])
    expect(abortedFetch).toBe('no answer')
  })
})

describe('where it is wired in', () => {
  const index = readFileSync(join(process.cwd(), 'server/index.ts'), 'utf8')
  it('index.ts lets the find POST past the mutation lease, before the lease is taken, with its own predicate', () => {
    const middleware = index.slice(index.indexOf("app.use('/api', (req, res, next) => {\n  if (req.method === 'GET'"), index.indexOf("acquireMaintenanceWork('api_mutation'"))
    expect(middleware).toContain('if (isSessionFindPost(req.method, req.path)) return next()')
    expect(middleware.indexOf('isSessionFindPost(')).toBeGreaterThan(middleware.indexOf('isReadOnlyApiPost('))
    // The existing predicate keeps its single call site, so its own pin (routes/work-search.test.ts) still holds.
    expect(index.split('isReadOnlyApiPost(').length - 1).toBe(1)
    expect(index.split('isSessionFindPost(').length - 1).toBe(1)
  })
  it('index.ts mounts the route behind the /api token, once', () => {
    expect(index.split('createSessionFindRouter()').length - 1).toBe(1)
    expect(index.indexOf('createSessionFindRouter()')).toBeGreaterThan(index.indexOf("app.use('/api', createWorkSearchRouter())"))
  })
})

describe('the capability', () => {
  const view = async (env: NodeJS.ProcessEnv) => {
    const app = express()
    app.use('/api', createDecisionProviderRouter({ env, read: () => ({ schema: 1, overrides: {} }), configured: () => ({ jev: true, subq: false }), keyStatus: () => ({ jev: { configured: true, source: 'config' }, subq: { configured: false, source: 'none' } }) }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/decision-provider`)
    return (await res.json()).capabilities as Record<string, unknown>
  }
  it('says sessionFind true only while the Sessions feature is on and the switch is not off', async () => {
    expect((await view({ COS_CLAUDE_SESSIONS_ENABLED: '1' })).sessionFind).toBe(true)
    expect(await view({})).not.toHaveProperty('sessionFind')
    expect(await view({ COS_CLAUDE_SESSIONS_ENABLED: '1', COS_SESSION_FIND: '0' })).not.toHaveProperty('sessionFind')
  })
  it('keeps every capability it had', async () => {
    expect(await view({ COS_CLAUDE_SESSIONS_ENABLED: '1' })).toMatchObject({ choices: ['jev', 'subq'], workflows: ['session', 'completion', 'search'], hotReload: true, fallback: false, subqImages: true, subqKeySource: 'config-or-env' })
  })
  it('reports sessionFind next to the selected search provider, and does not change what the setting says', async () => {
    const app = express()
    app.use('/api', createDecisionProviderRouter({ env: { COS_CLAUDE_SESSIONS_ENABLED: '1', COS_DECISION_PROVIDER_SEARCH: 'subq' }, read: () => ({ schema: 1, overrides: {} }), configured: () => ({ jev: true, subq: true }), keyStatus: () => ({ jev: { configured: true, source: 'config' }, subq: { configured: true, source: 'config' } }) }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/decision-provider`)).json()
    expect(body.effective).toMatchObject({ search: 'subq', session: 'jev', completion: 'jev' })
    expect(body.capabilities.sessionFind).toBe(true)
  })
})

describe('saving a new Jev key', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined) })
  it('clears this feature\'s breaker with the others', async () => {
    const jev = { resetForNewKey: vi.fn(), status: vi.fn(() => ({ ok: true })) }
    const searchJev = { resetForNewKey: vi.fn() }, findJev = { resetForNewKey: vi.fn() }
    const app = express(); app.use(express.json())
    app.use('/api', createJevRouter({ jev: jev as unknown as JevClient, searchJev, findJev, validate: async () => ({ ok: true }), save: () => undefined }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/jev-key/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'k'.repeat(24) }) })
    expect(res.status).toBe(200)
    expect(jev.resetForNewKey).toHaveBeenCalledTimes(1)
    expect(searchJev.resetForNewKey).toHaveBeenCalledTimes(1)
    expect(findJev.resetForNewKey).toHaveBeenCalledTimes(1)
  })
})

describe('when a cap or a pause ends (resetsAt)', () => {
  const NOW = Date.parse('2026-11-01T10:00:00Z')
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session find resets.')); vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-test-key-for-jev') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })

  async function viaRoute(jev: JevClient, decision?: Partial<import('../lib/decision-provider.js').DecisionClient>) {
    const client = { provider: 'jev' as const, ask: vi.fn(), ...decision } as import('../lib/decision-provider.js').DecisionClient
    const finder = new SessionFinder({ collector: new SessionFindCollector(), asker: new SessionFindAsker(), decision: client, roots: () => agentSessionRoots(dir), keyedIds: () => new Set(),
      available: () => ({ find: true, sessions: true }), selected: () => 'jev', configured: () => true, capacity: clientCapacity, jev, now: () => NOW })
    const app = express(); app.use(express.json()); app.use('/api', createSessionFindRouter({ finder }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent-sessions/find`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'the tailscale thing', consentedProvider: 'jev', stage: 'first' }) })
    return res.json() as Promise<SessionFindAnswer>
  }

  it('says the next UTC midnight of the ledger when the daily cap is reached', async () => {
    const ledger = join(dir, 'jev-usage.json')
    writeFileSync(ledger, JSON.stringify({ '2026-11-01': 50 }))
    const jev = new JevClient(fetch, () => new Date(NOW), ledger, () => 10)
    const answer = await viaRoute(jev)
    expect(answer).toMatchObject({ available: false, reason: 'cap_reached', resetsAt: '2026-11-02T00:00:00.000Z' })
  })

  it('says when the breaker reopens, as the client reports it', async () => {
    const jev = new JevClient((async () => { throw new Error('down') }) as unknown as typeof fetch, () => new Date(NOW), join(dir, 'jev-usage.json'), () => 1_000_000)
    for (let i = 0; i < 3; i++) await jev.ask({}, {}, 1).catch(() => undefined)
    const answer = await viaRoute(jev)
    expect(answer).toMatchObject({ available: false, reason: 'breaker_open', resetsAt: new Date(NOW + 3_600_000).toISOString() })
  })

  it('reads a SubQ breaker, which reports epoch milliseconds', async () => {
    const until = NOW + 1_800_000
    const subq = Object.assign(Object.create(SubqDecisionClient.prototype), { provider: 'subq', status: () => ({ configured: true, usedToday: 0, dailyCap: 10, breakerOpenUntil: until }) })
    const finder = new SessionFinder({ collector: new SessionFindCollector(), asker: new SessionFindAsker(), decision: subq, roots: () => agentSessionRoots(dir), keyedIds: () => new Set(),
      available: () => ({ find: true, sessions: true }), selected: () => 'subq', configured: () => true, capacity: clientCapacity, jev: null, now: () => NOW })
    const app = express(); app.use(express.json()); app.use('/api', createSessionFindRouter({ finder }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent-sessions/find`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'the tailscale thing', consentedProvider: 'subq', stage: 'first' }) })
    expect(await res.json()).toMatchObject({ reason: 'breaker_open', resetsAt: new Date(until).toISOString() })
  })

  it('omits it when nothing else says (not configured, consent, a breaker already past)', async () => {
    const answer = await viaRoute(new JevClient(fetch, () => new Date(NOW), join(dir, 'jev-usage.json'), () => 1_000_000))
    expect(answer.available).toBe(true) // an empty fake home: nothing to ask about, nothing refused
    expect(answer).not.toHaveProperty('resetsAt')
    expect(unavailableAnswer('consent_required', 'jev')).not.toHaveProperty('resetsAt')
  })
})
