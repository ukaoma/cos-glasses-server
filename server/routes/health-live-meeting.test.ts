// 6.86.0: COS Control gates the live meeting view by capability. Both surfaces publish the same values from one helper.
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

const KINDS = ['reinforce', 'challenge', 'decision', 'promise', 'followUp']
const LIVE_MEETING = { protocol: 1, macLiveCues: true, provisional: { route: '/api/transcribe-stream/provisional', maxChars: 600, ttlMs: 30_000 }, chunkLevels: true }

describe('live meeting capabilities (6.86.0)', () => {
  it('/api/health: capabilities.liveCues.kinds lists the five kinds beside the v1 fields, and capabilities.liveMeeting is published', async () => {
    const body = await (await fetch(`${base}/api/health`)).json() as any
    expect(body.capabilities.liveCues.kinds).toEqual(KINDS)
    expect(typeof body.capabilities.liveCues.available).toBe('boolean')       // the v1 fields the companion reads are untouched
    expect(body.features.liveCues).toBe(body.capabilities.liveCues.available)
    expect(body.capabilities.liveMeeting).toEqual(LIVE_MEETING)
  }, 20_000)
  it('/api/models publishes the same values', async () => {
    const body = await (await fetch(`${base}/api/models`)).json() as any
    expect(body.capabilities.liveCues.kinds).toEqual(KINDS)
    expect(body.capabilities.liveMeeting).toEqual(LIVE_MEETING)
  }, 20_000)
})
