// Health advertises the boot-planned, signed phone authority, never a raw environment flag.
import express from 'express'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebKeyActivation, registerWebKeyActivation } from '../lib/web-key-activation.js'
import { WebKeyRegistry } from '../lib/web-key-registry.js'
import { p256, seedRegistry, SELF_DNS, signB64, type TestKey } from '../lib/__fixtures__/web-key-kit.js'
import { healthRouter } from './health.js'

let server: Server | null = null
let base = '', dir: string, activation: WebKeyActivation, anchor: TestKey
const device = '100.101.102.103'
const keys = ['COS_WEB_KEY_AUTHORITY', 'COS_WEB_KEY_DEVICES', 'COS_WEB_KEY_ANCHOR_BOOTSTRAP'] as const
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
beforeAll(async () => {
  const app = express()
  app.use('/api', healthRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server!.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})
beforeEach(() => {
  for (const key of keys) delete process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'health-web-key-'))
  anchor = p256(); seedRegistry(join(dir, 'keys.json'), anchor)
  const registry = new WebKeyRegistry(join(dir, 'keys.json'), join(dir, 'audit.jsonl'), () => 1_786_000_000_000)
  activation = new WebKeyActivation({ registry, selfDnsName: () => SELF_DNS, now: () => 1_786_000_000_000 })
  registerWebKeyActivation(activation)
})
afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
afterEach(() => {
  registerWebKeyActivation(null)
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
  rmSync(dir, { recursive: true, force: true })
})
async function health(): Promise<{ webKeySigner?: number }> {
  const response = await fetch(`${base}/api/health`)
  expect(response.status).toBe(200)
  return await response.json() as { webKeySigner?: number }
}
function signedGrant(): void {
  const challenge = activation.challenge(device)
  if (!challenge.ok) throw new Error(challenge.reason)
  expect(activation.accept(challenge.statement, signB64(anchor, Buffer.from(challenge.statement, 'base64url')))).toEqual({ ok: true })
}
function configure(): void { process.env.COS_WEB_KEY_AUTHORITY = '1'; process.env.COS_WEB_KEY_DEVICES = device }

describe('health webKeySigner signed activation', () => {
  it('flag unset or0: no signer even with a signed boot-planned grant', async () => {
    configure(); signedGrant(); expect(activation.armAtBoot()).toBe(true)
    delete process.env.COS_WEB_KEY_AUTHORITY
    expect(await health()).not.toHaveProperty('webKeySigner')
    process.env.COS_WEB_KEY_AUTHORITY = '0'
    expect(await health()).not.toHaveProperty('webKeySigner')
  }, 20_000)
  it('bootstrap switch alone still offers no signer', async () => {
    process.env.COS_WEB_KEY_ANCHOR_BOOTSTRAP = '1'
    expect(await health()).not.toHaveProperty('webKeySigner')
  }, 20_000)
  it('raw authority flag plus mature anchor and matching device cannot advertise a signer', async () => {
    configure(); expect(activation.armAtBoot()).toBe(false)
    expect(await health()).not.toHaveProperty('webKeySigner')
  }, 20_000)
  it('signed boot-planned authority advertises1; Off removes it immediately with raw flag still1', async () => {
    configure(); signedGrant(); expect(activation.armAtBoot()).toBe(true)
    expect((await health()).webKeySigner).toBe(1)
    expect(activation.off()).toEqual({ ok: true }); expect(process.env.COS_WEB_KEY_AUTHORITY).toBe('1')
    expect(await health()).not.toHaveProperty('webKeySigner')
  }, 20_000)
  it('a grant accepted after an unplanned boot cannot advertise a nonexistent signer', async () => {
    configure(); expect(activation.armAtBoot()).toBe(false); signedGrant()
    expect(activation.accepted()).toBe(true); expect(await health()).not.toHaveProperty('webKeySigner')
  }, 20_000)
})
