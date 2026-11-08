// 6.99.31 Phase 3: /api/health says the phone key signer exists (webKeySigner 1) only with
// COS_WEB_KEY_AUTHORITY on. Off, the field is absent, so Control Web's composer offers nothing.
import express from 'express'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { healthRouter } from './health.js'

let server: Server | null = null
let base = ''
const saved = process.env.COS_WEB_KEY_AUTHORITY
beforeAll(async () => {
  const app = express()
  app.use('/api', healthRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server!.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})
afterAll(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
afterEach(() => { if (saved === undefined) delete process.env.COS_WEB_KEY_AUTHORITY; else process.env.COS_WEB_KEY_AUTHORITY = saved })

describe('health webKeySigner (6.99.31)', () => {
  it('flag unset or 0: no webKeySigner field at all', async () => {
    delete process.env.COS_WEB_KEY_AUTHORITY
    expect('webKeySigner' in (await (await fetch(`${base}/api/health`)).json() as object)).toBe(false)
    process.env.COS_WEB_KEY_AUTHORITY = '0'
    expect('webKeySigner' in (await (await fetch(`${base}/api/health`)).json() as object)).toBe(false)
  }, 20_000)
  it('flag on: webKeySigner 1', async () => {
    process.env.COS_WEB_KEY_AUTHORITY = '1'
    expect(((await (await fetch(`${base}/api/health`)).json()) as { webKeySigner?: number }).webKeySigner).toBe(1)
  }, 20_000)
})
