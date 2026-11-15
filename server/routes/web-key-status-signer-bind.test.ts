// SR-15: GET /api/web-key/status carries signerBindFixVersion, signerBind and certDisclosure in every mode,
// and with both switches off answers a TOKEN-bearing read with those facts only, so COS Control can show
// the certificate-log disclosure before the first On. Real router, real registry; the facts are a stub.
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebKeyAuthority } from '../lib/web-key-authority.js'
import { WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from '../lib/web-key-registry.js'
import { webKeySignerOrigin } from '../lib/web-key-origin.js'
import { createWebKeyRouter } from './web-key.js'
import { INTEGRITY_OK, p256, seedRegistry, SELF_DNS } from '../lib/__fixtures__/web-key-kit.js'

type Mode = 'off' | 'bootstrap' | 'authority'
const FACTS = {
  signerBindFixVersion: 1,
  signerBind: { scope: 'tailnet', addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'], reason: null, listening: false },
  certDisclosure: { issued: false, publicName: SELF_DNS },
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

/** `facts: null`: a deployment that does not wire signerFacts at all. */
async function rig(mode: Mode, facts: (() => Record<string, unknown> | null) | null = () => FACTS) {
  const dir = mkdtempSync(join(tmpdir(), 'web-key-status-bind-'))
  seedRegistry(join(dir, 'web-keys.json'), p256())
  const registry = new WebKeyRegistry(join(dir, 'web-keys.json'), join(dir, 'audit.jsonl'))
  const selfDnsName = () => SELF_DNS
  const authority = new WebKeyAuthority({
    registry, nonces: new WebKeyNonces(join(dir, 'n.json')), packets: new WebKeyPackets(),
    integrity: () => INTEGRITY_OK, selfDnsName, expectedOrigin: () => webKeySignerOrigin(selfDnsName()),
    enabled: () => mode === 'authority', bootstrap: () => mode === 'bootstrap',
  })
  const app = express()
  app.use(express.json())
  app.use('/api', createWebKeyRouter({
    authority, enrollments: new WebKeyEnrollments(registry, { deviceAllowed: () => true }),
    isWebRequest: () => false, apiToken: () => 'tok', selfDnsName,
    expectedOrigin: () => authority.deps.expectedOrigin(),
    ...(facts ? { signerFacts: facts } : {}),
  }))
  app.use((_req, res) => { res.status(404).json({ fellThrough: true }) })
  const server: Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  closers.push(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return async (headers: Record<string, string> = { 'x-cos-token': 'tok' }) => {
    const res = await fetch(`${base}/api/web-key/status`, { headers })
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() as Record<string, unknown> }
  }
}

describe('both switches off', () => {
  it('token: 200 with mode off and the signer facts only (no origin, aud or anchor field)', async () => {
    const r = await (await rig('off'))()
    expect(r.status).toBe(200)
    expect(r.cache).toBe('private, no-store')
    expect(r.body).toEqual({ ok: true, enabled: false, mode: 'off', ...FACTS })
  })

  it('no token, or a wrong token: falls through exactly as before (no new door)', async () => {
    const status = await rig('off')
    expect(await status({})).toEqual({ status: 404, cache: null, body: { fellThrough: true } })
    expect((await status({ 'x-cos-token': 'nope' })).body).toEqual({ fellThrough: true })
  })

  it('a deployment that does not report the facts: falls through even with the token (old behaviour)', async () => {
    const r = await (await rig('off', null))()
    expect(r).toEqual({ status: 404, cache: null, body: { fellThrough: true } })
  })
})

describe('bootstrap and authority: the existing body plus the three fields', () => {
  it('bootstrap', async () => {
    const r = await (await rig('bootstrap'))()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, enabled: false, mode: 'bootstrap', anchorRegistered: true, origin: `https://${SELF_DNS}:3144`, ...FACTS })
    expect(Object.keys(r.body)).toEqual(['ok', 'enabled', 'mode', 'anchorRegistered', 'anchorMature', 'anchorSetAt', 'aud', 'origin', 'epoch', 'signerBindFixVersion', 'signerBind', 'certDisclosure'])
  })

  it('bootstrap without a token is still refused', async () => {
    expect((await (await rig('bootstrap'))({})).status).toBe(401)
  })

  it('authority', async () => {
    const r = await (await rig('authority'))()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, enabled: true, origin: `https://${SELF_DNS}:3144`, ...FACTS })
    expect(Object.keys(r.body).slice(-3)).toEqual(['signerBindFixVersion', 'signerBind', 'certDisclosure'])
  })

  it('facts that throw or are null: the status still answers, without them', async () => {
    for (const facts of [() => { throw new Error('ifaces') }, () => null]) {
      for (const mode of ['bootstrap', 'authority'] as const) {
        const r = await (await rig(mode, facts))()
        expect(r.status).toBe(200)
        expect(r.body).not.toHaveProperty('signerBind')
        expect(r.body).not.toHaveProperty('certDisclosure')
      }
      const off = await (await rig('off', facts))()
      expect(off).toMatchObject({ status: 200, body: { ok: true, enabled: false, mode: 'off' } })
      expect(off.body).not.toHaveProperty('signerBind')
    }
  })
})
