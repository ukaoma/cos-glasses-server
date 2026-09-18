import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLIENT_INSTANCE_CAPTURE_LIVE_MS, CLIENT_INSTANCE_LIVE_MS, CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS, arbitrateClientInstance, parseClientInstanceClaim } from '../lib/client-instance-claim.js'
import { createClientInstanceRouter, deviceKey } from './client-instance.js'

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

  it('check answers without taking, even when the owner looks quiet', async () => {
    clock += 1_000
    expect((await post(newer)).body.verdict).toBe('owner')
    // The owner goes quiet past the live window (a locked phone froze its timers too).
    clock += CLIENT_INSTANCE_LIVE_MS + 1
    const checked = await post({ ...older, check: true })
    expect(checked.body).toMatchObject({ verdict: 'owner', check: true, owner: { id: newer.id } })
    // It did not take: the newer copy's next post is still the owner, the older still yields.
    expect((await post(newer)).body).toMatchObject({ verdict: 'owner', owner: { id: newer.id } })
    expect((await post({ ...older, check: true })).body.verdict).toBe('yield')
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
    const mount = index.indexOf("app.use('/api', createClientInstanceRouter({ lastRecordingChunkAt }))")
    expect(auth).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(-1)
    expect(auth).toBeLessThan(mount)
    const auth2 = readFileSync(new URL('../lib/api-auth.ts', import.meta.url), 'utf8')
    expect(auth2).not.toContain("'/client-instance")
  })
})

describe('6.50.4: no handover mid-meeting, one owner per device, no clock from the future', () => {
  it('while a meeting is live the owner keeps the ring, even when it has gone quiet; after, the newer copy takes it', () => {
    let r = arbitrateClientInstance(null, older, T0)
    // The 08:15 case: the phone page goes blank mid-meeting, Miles reopens COS.
    const held = arbitrateClientInstance(r.owner, newer, T0 + 1_000, true)
    expect(held).toMatchObject({ verdict: 'yield', took: false })
    expect(held.owner.id).toBe(older.id)
    // Hidden, the recording copy's claims can lapse past the live window: still held.
    const quiet = arbitrateClientInstance(held.owner, newer, T0 + 10 * CLIENT_INSTANCE_LIVE_MS, true)
    expect(quiet.verdict).toBe('yield')
    // Meeting stopped: the newer copy takes the ring on its next claim.
    expect(arbitrateClientInstance(quiet.owner, newer, T0 + 10 * CLIENT_INSTANCE_LIVE_MS + 1, false)).toMatchObject({ verdict: 'owner', took: true })
  })

  it('refuses a boot time more than an hour past the server clock', () => {
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: T0 + CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS + 1 }, T0)).toBeNull()
    expect(parseClientInstanceClaim({ id: 'mu707t9p-ai9g', bootAt: T0 + CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS }, T0)).not.toBeNull()
  })

  it('an IPv4-mapped address and its IPv4 form are one device', () => {
    expect(deviceKey('::ffff:100.64.1.2')).toBe('100.64.1.2')
    expect(deviceKey('100.64.1.2')).toBe('100.64.1.2')
    expect(deviceKey(undefined)).toBe('unknown')
  })

  describe('over HTTP', () => {
    let server: Server | null = null
    let port = 0
    let clock = T0
    let lastChunk = 0
    beforeAll(async () => {
      const app = express()
      app.use(express.json())
      app.use('/api', createClientInstanceRouter({ now: () => clock, lastRecordingChunkAt: () => lastChunk }))
      await new Promise<void>(resolve => { server = app.listen(0, '::', () => resolve()) })
      const addr = server!.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
    })
    afterAll(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
    const post = async (host: string, body: unknown) => {
      const res = await fetch(`http://${host}:${port}/api/client-instance/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() as any }
    }

    it('a live meeting holds the ring; the answer says so', async () => {
      expect((await post('127.0.0.1', older)).body.verdict).toBe('owner')
      lastChunk = clock
      clock += 5_000
      const r = await post('127.0.0.1', newer)
      expect(r.body).toMatchObject({ verdict: 'yield', captureLive: true, owner: { id: older.id } })
      clock += CLIENT_INSTANCE_CAPTURE_LIVE_MS
      expect((await post('127.0.0.1', newer)).body).toMatchObject({ verdict: 'owner', captureLive: false })
    })

    it('another device keeps its own owner and cannot take this one', async () => {
      // ::1 is a different device from 127.0.0.1: a simulator on the Mac, say.
      const sim = { id: 'zzzz9999-sim1', bootAt: clock + 1_000, version: 'sim' }
      expect((await post('[::1]', sim)).body).toMatchObject({ verdict: 'owner', owner: { id: sim.id } })
      // The phone's owner is untouched.
      expect((await post('127.0.0.1', { ...older, check: true })).body).toMatchObject({ verdict: 'yield', owner: { id: newer.id } })
    })

    it('a future boot time is a 400', async () => {
      expect((await post('127.0.0.1', { ...newer, id: 'fut00000-0001', bootAt: clock + 2 * CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS })).status).toBe(400)
    })
  })
})
