import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLIENT_INSTANCE_LIVE_MS, arbitrateClientInstance, parseClientInstanceClaim } from '../lib/client-instance-claim.js'
import { createClientInstanceRouter } from './client-instance.js'

const T0 = 1_789_744_000_000
const older = { id: 'mu707t9p-ai9g', bootAt: T0 - 5_000_000, version: '6.9.507' }
const newer = { id: 'mu73csa5-lgxq', bootAt: T0, version: '6.9.507' }

describe('the client-instance referee (6.50.3)', () => {
  it('the newest live boot owns the ring; an older copy yields until the owner goes quiet', () => {
    let r = arbitrateClientInstance(null, older, T0)
    expect(r.verdict).toBe('owner')
    r = arbitrateClientInstance(r.owner, newer, T0 + 1_000)
    expect(r).toMatchObject({ verdict: 'owner', took: true })
    // The 2026-09-18 zombie posts: it yields.
    r = arbitrateClientInstance(r.owner, older, T0 + 15_000)
    expect(r.verdict).toBe('yield')
    expect(r.owner.id).toBe(newer.id)
    // The newer copy keeps posting: still the owner.
    r = arbitrateClientInstance(r.owner, newer, T0 + 16_000)
    expect(r.verdict).toBe('owner')
    // Right at the live edge the older still yields; one ms past, the newer is gone and it takes over.
    expect(arbitrateClientInstance(r.owner, older, T0 + 16_000 + CLIENT_INSTANCE_LIVE_MS).verdict).toBe('yield')
    const back = arbitrateClientInstance(r.owner, older, T0 + 16_000 + CLIENT_INSTANCE_LIVE_MS + 1)
    expect(back).toMatchObject({ verdict: 'owner', took: true })
    expect(back.owner.id).toBe(older.id)
  })

  it('two boots in the same millisecond: exactly one owns', () => {
    const a = { id: 'aaaa-0001', bootAt: T0, version: '' }
    const b = { id: 'bbbb-0001', bootAt: T0, version: '' }
    const first = arbitrateClientInstance(null, a, T0)
    const second = arbitrateClientInstance(first.owner, b, T0 + 1)
    const third = arbitrateClientInstance(second.owner, a, T0 + 2)
    expect([second.verdict, third.verdict].sort()).toEqual(['owner', 'yield'])
    expect(second.owner.id).toBe('bbbb-0001')
  })

  it('rejects anything but a well-formed claim', () => {
    expect(parseClientInstanceClaim(null)).toBeNull()
    expect(parseClientInstanceClaim({ id: 'x', bootAt: 1 })).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: 'x' })).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: -1 })).toBeNull()
    expect(parseClientInstanceClaim({ id: '../etc-passwd', bootAt: 1 })).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: 1, version: 'v'.repeat(99) })?.version).toHaveLength(32)
  })
})

describe('POST /api/client-instance/claim', () => {
  let server: Server | null = null
  let base = ''
  let clock = T0
  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createClientInstanceRouter(() => clock))
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
    const addr = server!.address()
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
  })
  afterAll(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/client-instance/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }

  it('answers each copy owner or yield, keeping state across requests', async () => {
    expect((await post(older)).body.verdict).toBe('owner')
    clock += 1_000
    expect((await post(newer)).body).toMatchObject({ verdict: 'owner', owner: { id: newer.id } })
    clock += 14_000
    const z = await post(older)
    expect(z.status).toBe(200)
    expect(z.body).toMatchObject({ verdict: 'yield', owner: { id: newer.id } })
  })

  it('a malformed claim is a 400 and changes nothing', async () => {
    expect((await post({ id: 'nope' })).status).toBe(400)
    expect((await post(newer)).body.verdict).toBe('owner')
  })
})

describe('mounting', () => {
  it('the referee is mounted AFTER the API token check and is not a public path', async () => {
    const { readFileSync } = await import('node:fs')
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const auth = index.indexOf("app.use('/api', requireApiToken(API_TOKEN))")
    const mount = index.indexOf("app.use('/api', createClientInstanceRouter())")
    expect(auth).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(-1)
    expect(auth).toBeLessThan(mount)
    const auth2 = readFileSync(new URL('../lib/api-auth.ts', import.meta.url), 'utf8')
    expect(auth2).not.toContain("'/client-instance")
  })
})
