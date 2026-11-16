import { afterEach, beforeEach, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebKeyActivation } from '../lib/web-key-activation.js'
import { WebKeyAuthority } from '../lib/web-key-authority.js'
import { WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from '../lib/web-key-registry.js'
import { p256, seedRegistry, SELF_DNS, signB64, type TestKey } from '../lib/__fixtures__/web-key-kit.js'
import { createWebKeyRouter } from './web-key.js'
let server: Server, dir: string, base: string, anchor: TestKey, env: NodeJS.ProcessEnv
let activation: WebKeyActivation
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'activation-routes-')); anchor = p256(); seedRegistry(join(dir, 'keys.json'), anchor)
  const registry = new WebKeyRegistry(join(dir, 'keys.json'), join(dir, 'audit.jsonl'))
  env = { COS_WEB_KEY_AUTHORITY: '0', COS_WEB_KEY_DEVICES: '100.101.102.103' }
  activation = new WebKeyActivation({ registry, selfDnsName: () => SELF_DNS, env: () => env })
  const authority = new WebKeyAuthority({ registry, nonces: new WebKeyNonces(join(dir, 'n.json')), packets: new WebKeyPackets(), selfDnsName: () => SELF_DNS, expectedOrigin: () => `https://${SELF_DNS}:3144`, enabled: () => activation.enabled(), bootstrap: () => false })
  const app = express(); app.use(express.json())
  // Test-only transport seam: exercise actual router gate without exposing a network fixture to a LAN.
  app.use((req, _res, next) => { if (req.headers['x-test-remote']) Object.defineProperty(req.socket, 'remoteAddress', { value: req.headers['x-test-remote'], configurable: true }); next() })
  app.use('/api', createWebKeyRouter({ activation, authority, enrollments: new WebKeyEnrollments(registry), selfDnsName: () => SELF_DNS, expectedOrigin: authority.deps.expectedOrigin, apiToken: () => 'private-fixture-token', isWebRequest: () => true }))
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }) })
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/web-key`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) })
async function call(path: string, method = 'POST', body: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-cos-token': 'private-fixture-token', ...headers }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}
it('off bootstrap challenge→accept→exact env On→authority→Off works through real router', async () => {
  const status = await call('/status', 'GET'); expect(status.body).toMatchObject({ enabled: false, mode: 'off', activationProtocol: 'cos-web-authority-on/1', activationEpoch: 0, activationAccepted: false, anchorRegistered: true, anchorMature: true }); expect(status.body).not.toHaveProperty('origin')
  const c = await call('/activation/challenge', 'POST', { device: env.COS_WEB_KEY_DEVICES }); expect(c.status).toBe(200)
  const statement = c.body.statement as string
  expect((await call('/activation', 'POST', { statement, signature: signB64(anchor, Buffer.from(statement, 'base64url')) })).body).toMatchObject({ ok: true, activationAccepted: true, enabled: false })
  env.COS_WEB_KEY_AUTHORITY = '1'; expect((await call('/status', 'GET')).body.enabled).toBe(false)
  activation.armAtBoot(); expect((await call('/status', 'GET')).body.enabled).toBe(true)
  expect((await call('/activation', 'DELETE')).body).toMatchObject({ ok: true, activationEpoch: 1, activationAccepted: false, enabled: false })
  expect((await call('/activation', 'POST', { statement, signature: signB64(anchor, Buffer.from(statement, 'base64url')) })).status).toBe(400)
})
it.each(['/activation/challenge', '/activation'])('rejects tokenless/cookie-only and wrong token %s', async path => {
  expect((await call(path, 'POST', {}, { 'x-cos-token': '', cookie: 'cos_web_session=anything' })).status).toBe(401)
  expect((await call(path, 'POST', {}, { 'x-cos-token': 'wrong' })).status).toBe(401)
})
it.each(['POST', 'DELETE'])('rejects token LAN, own tailnet, and forwarding headers for %s', async method => {
  const path = method === 'POST' ? '/activation/challenge' : '/activation'
  for (const headers of ([{ 'x-test-remote': '192.168.1.4' }, { 'x-test-remote': '100.101.102.103' }, { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-host': 'local' }] as Array<Record<string, string>>)) {
    expect((await call(path, method, {}, headers)).status).toBe(403)
  }
})
it('closed request schema and no authority routes from raw env alone', async () => {
  expect((await call('/activation/challenge', 'POST', { device: '100.101.102.103', publicName: 'attacker.ts.net' })).status).toBe(400)
  expect((await call('/activation', 'DELETE', { retain: true })).status).toBe(400)
  env.COS_WEB_KEY_AUTHORITY = '1'
  expect((await call('/enroll/start', 'POST')).status).toBe(404)
})
