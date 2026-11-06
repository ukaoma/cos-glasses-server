// 6.99.19: capabilities.prep on both capability surfaces. Absent on an older server, where "Prep me" stays a plain Ask.
import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { healthRouter } from './health.js'

let server: Server | null = null
let base = ''
beforeAll(async () => {
  const app = express()
  app.use('/api', healthRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server!.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})
afterAll(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })

const PREP = { protocol: 1, maxFiles: 10, steerChars: 4000, bind: true, suggest: true }

describe('Prep capability (6.99.19)', () => {
  it('/api/health publishes capabilities.prep', async () => {
    const body = await (await fetch(`${base}/api/health`)).json() as any
    expect(body.capabilities.prep).toEqual({ ...PREP, serverInstanceId: body.capabilities.prep.serverInstanceId })
    expect('serverInstanceId' in body.capabilities.prep).toBe(true)   // v1.1 #2: the server a client will write to
  }, 20_000)
  it('/api/models publishes the same value', async () => {
    const body = await (await fetch(`${base}/api/models`)).json() as any
    expect(body.capabilities.prep).toEqual({ ...PREP, serverInstanceId: body.capabilities.prep.serverInstanceId })
    expect('serverInstanceId' in body.capabilities.prep).toBe(true)
  }, 20_000)
})
