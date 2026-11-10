// 7.0.14: a boot-time miss of this Mac's tailnet name must not stick. Before, /api/web-key/status
// served the cached miss (`origin: null`, so COS Control hid Phone approvals) and the 3144 signer
// refused every phone write `origin_refused`, until some other route happened to refresh the name.
// Real status route, real signer handler, real createTailnetSelfName; the MagicDNS reverse lookup
// (the only thing the name lookup runs) is a counting fake.
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTailnetSelfName,
  TAILNET_NAME_ON_DEMAND_MIN_MS,
  type TailnetSelfName,
} from '../lib/tailnet-self-name.js'
import { WebKeyAuthority } from '../lib/web-key-authority.js'
import { WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from '../lib/web-key-registry.js'
import { webKeySignerOrigin } from '../lib/web-key-origin.js'
import { createWebKeySignerHandler } from '../lib/web-key-signer-app.js'
import { createWebKeyRouter } from './web-key.js'
import { INTEGRITY_OK, ORIGIN, p256, seedRegistry, SELF_DNS } from '../lib/__fixtures__/web-key-kit.js'

const TS_IP = '100.108.149.114'

interface Rig {
  self: TailnetSelfName
  /** MagicDNS reverse lookups actually run. */
  lookups: () => number
  /** Times the status route asked for a refresh (the route-level guard). */
  asked: () => number
  answer: (names: string[] | 'hang' | 'deferred') => void
  release: () => void
  tick: (ms: number) => void
  status: (headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }>
  close: () => Promise<void>
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => { while (servers.length) await servers.pop()!() })

async function rig(opts: { mode?: 'authority' | 'bootstrap'; nudger?: () => string | null } = {}): Promise<Rig> {
  let clock = 1_786_000_000_000
  let lookups = 0
  let asked = 0
  let names: string[] | 'hang' | 'deferred' = []
  let releaseDeferred: () => void = () => {}
  const self = createTailnetSelfName({
    nudgerName: opts.nudger ?? (() => null),
    tailscaleIpv4: () => TS_IP,
    now: () => clock,
    reverse: async ip => {
      lookups++
      expect(ip).toBe(TS_IP)
      if (names === 'hang') return new Promise<string[]>(() => {})
      if (names === 'deferred') {
        await new Promise<void>(r => { releaseDeferred = r })
        return [`${SELF_DNS}.`]
      }
      return names
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'web-key-status-name-'))
  seedRegistry(join(dir, 'web-keys.json'), p256())
  const registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'), () => clock)
  const selfDnsName = (): string | null => self.currentSelfDnsName()
  const authority = new WebKeyAuthority({
    registry, nonces: new WebKeyNonces(join(dir, 'n.json'), () => clock), packets: new WebKeyPackets(() => clock),
    integrity: () => INTEGRITY_OK, selfDnsName, expectedOrigin: () => webKeySignerOrigin(selfDnsName()),
    enabled: () => (opts.mode ?? 'authority') === 'authority', bootstrap: () => true, now: () => clock,
  })
  const app = express()
  app.use(express.json())
  app.use('/api', createWebKeyRouter({
    authority, enrollments: new WebKeyEnrollments(registry, { now: () => clock, deviceAllowed: () => true }),
    isWebRequest: () => false, apiToken: () => 'tok', selfDnsName,
    refreshSelfDnsName: () => { asked++; return self.refreshIfMissing() },
    expectedOrigin: () => authority.deps.expectedOrigin(),
  }))
  const server: Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = async (): Promise<void> => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) }
  servers.push(close)
  return {
    self,
    lookups: () => lookups,
    asked: () => asked,
    answer: n => { names = n },
    release: () => releaseDeferred(),
    tick: ms => { clock += ms },
    status: async (headers = { 'x-cos-token': 'tok' }) => {
      const res = await fetch(`${base}/api/web-key/status`, { headers })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    },
    close,
  }
}

/** The boot lookup in index.ts, missing (the startup race). */
async function bootMiss(r: Rig): Promise<void> {
  r.answer([])
  expect(await r.self.refresh()).toBeNull()
  expect(r.lookups()).toBe(1)
  expect(r.self.currentSelfDnsName()).toBeNull()
}

describe('/api/web-key/status after a boot miss of the tailnet name', () => {
  it('(1) the first status request looks the name up exactly once and answers the real origin', async () => {
    const r = await rig()
    await bootMiss(r)
    r.answer([`${SELF_DNS.toUpperCase()}.`])
    const first = await r.status()
    expect(first.status).toBe(200)
    expect(first.body.origin).toBe(ORIGIN)
    expect(first.body.aud).toMatch(/^[0-9a-f]{64}$/)
    expect(r.lookups()).toBe(2)
    // Learned: later requests read it without looking anything up.
    expect((await r.status()).body.origin).toBe(ORIGIN)
    expect(r.lookups()).toBe(2)
  })

  it('(1b) the same holds in anchor-bootstrap mode (COS Control reads origin there too)', async () => {
    const r = await rig({ mode: 'bootstrap' })
    await bootMiss(r)
    r.answer([SELF_DNS])
    const first = await r.status()
    expect(first.body).toMatchObject({ mode: 'bootstrap', origin: ORIGIN })
    expect(r.lookups()).toBe(2)
  })

  it('(2) concurrent status requests share ONE lookup, and every one answers the real origin', async () => {
    const r = await rig()
    await bootMiss(r)
    r.answer('deferred')
    const pending = Array.from({ length: 5 }, () => r.status())
    // All five are inside the route, waiting, before the lookup answers.
    for (let i = 0; i < 200 && r.asked() < 5; i++) await new Promise(res => setTimeout(res, 5))
    expect(r.asked()).toBe(5)
    r.release()
    const answers = await Promise.all(pending)
    expect(answers.map(a => a.body.origin)).toEqual(Array(5).fill(ORIGIN))
    expect(r.lookups()).toBe(2)
  })

  it('(3) while the name stays unknown, at most one on-demand lookup per window, and no waiting in between', async () => {
    const r = await rig()
    await bootMiss(r)
    // The boot lookup does not count against the window: the first reader looks at once.
    expect((await r.status()).body.origin).toBeNull()
    expect(r.lookups()).toBe(2)
    r.tick(TAILNET_NAME_ON_DEMAND_MIN_MS - 1)
    const started = Date.now()
    expect((await r.status()).body.origin).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await r.status()).body.origin).toBeNull()
    expect(r.lookups()).toBe(2)
    r.tick(1)
    r.answer([SELF_DNS])
    expect((await r.status()).body.origin).toBe(ORIGIN)
    expect(r.lookups()).toBe(3)
  })

  it('(4) a known name never runs a lookup and never asks for one, from the nudger or the cache', async () => {
    const viaNudger = await rig({ nudger: () => `${SELF_DNS}.` })
    for (let i = 0; i < 4; i++) expect((await viaNudger.status()).body.origin).toBe(ORIGIN)
    expect(viaNudger.lookups()).toBe(0)
    expect(viaNudger.asked()).toBe(0)

    const viaCache = await rig()
    viaCache.answer([SELF_DNS])
    expect(await viaCache.self.refresh()).toBe(SELF_DNS)
    expect(viaCache.lookups()).toBe(1)
    viaCache.answer([])
    viaCache.tick(11 * 60_000) // past the hit TTL: still a known name
    for (let i = 0; i < 4; i++) expect((await viaCache.status()).body.origin).toBe(ORIGIN)
    expect(viaCache.lookups()).toBe(1)
    expect(viaCache.asked()).toBe(0)
    // The library guard on its own, not only the route's.
    expect(await viaCache.self.refreshIfMissing()).toBe(SELF_DNS)
    expect(viaCache.lookups()).toBe(1)
  })

  it('an unauthenticated request is refused before anything is looked up', async () => {
    const r = await rig()
    await bootMiss(r)
    r.answer([SELF_DNS])
    expect((await r.status({})).status).toBe(401)
    expect(r.asked()).toBe(0)
    expect(r.lookups()).toBe(1)
  })
})

describe('refreshIfMissing: the wait is bounded', () => {
  it('a lookup that never answers is waited on for at most waitMs; later readers do not stack lookups', async () => {
    const r = await rig()
    await bootMiss(r)
    r.answer('hang')
    const raced = await Promise.race([
      r.self.refreshIfMissing(30).then(v => ({ v })),
      new Promise<'hung'>(res => setTimeout(() => res('hung'), 1_000)),
    ])
    expect(raced).toEqual({ v: null })
    expect(r.lookups()).toBe(2)
    // Still in flight: the next reader joins it (bounded again), it does not start another.
    expect(await r.self.refreshIfMissing(10)).toBeNull()
    r.tick(TAILNET_NAME_ON_DEMAND_MIN_MS)
    expect(await r.self.refreshIfMissing(10)).toBeNull()
    expect(r.lookups()).toBe(2)
  })
})

describe('3144 signer: a null origin is refreshed before the origin check', () => {
  async function signer(origin: () => string | null, refresh: (() => Promise<unknown>) | undefined): Promise<{ base: string; apiCalls: string[] }> {
    const apiCalls: string[] = []
    const server = createServer(createWebKeySignerHandler({
      integrity: null, recheckMs: 0, origin, ...(refresh ? { refreshOrigin: refresh } : {}),
      api: (q, s) => { apiCalls.push(`${q.method} ${q.url}`); s.statusCode = 200; s.end('{"ok":true}') },
    }))
    await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()))
    servers.push(() => new Promise<void>(res => server.close(() => res())))
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiCalls }
  }
  const post = (base: string, origin: string) => fetch(`${base}/api/web-key/nonce`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })

  it('boot miss then a phone write: one bounded lookup, then the write reaches the API', async () => {
    const r = await rig()
    await bootMiss(r)
    r.answer([SELF_DNS])
    let refreshes = 0
    const s = await signer(() => webKeySignerOrigin(r.self.currentSelfDnsName()), () => { refreshes++; return r.self.refreshIfMissing() })
    const res = await post(s.base, ORIGIN)
    expect(res.status).toBe(200)
    expect(s.apiCalls).toEqual(['POST /api/web-key/nonce'])
    expect(refreshes).toBe(1)
    expect(r.lookups()).toBe(2)
  })

  it('a name still unknown after the lookup still refuses (null never matches), and another origin is refused', async () => {
    const r = await rig()
    await bootMiss(r)
    let refreshes = 0
    const s = await signer(() => webKeySignerOrigin(r.self.currentSelfDnsName()), () => { refreshes++; return r.self.refreshIfMissing() })
    const res = await post(s.base, ORIGIN)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'origin_refused' })
    expect(refreshes).toBe(1)
    expect(s.apiCalls).toEqual([])
  })

  it('a known origin never calls the refresh', async () => {
    let refreshes = 0
    const s = await signer(() => ORIGIN, async () => { refreshes++ })
    expect((await post(s.base, ORIGIN)).status).toBe(200)
    expect((await post(s.base, 'https://evil.example')).status).toBe(403)
    expect(refreshes).toBe(0)
  })
})
