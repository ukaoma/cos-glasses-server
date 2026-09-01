import express from 'express'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetDisplayBusForTests, emitDisplay } from '../lib/display-bus.js'
import { serverMetrics } from '../lib/server-metrics.js'
import { displayRouter } from './display.js'
import { mintDisplayTicket } from '../lib/display-ticket.js'

let server: Server | null = null

async function startServer(): Promise<string> {
  const app = express()
  app.use('/api', displayRouter)
  server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener unavailable')
  return `http://127.0.0.1:${address.port}`
}

async function readFrames(url: string, count: number): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  const response = await fetch(url, { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.split('\n\n').filter(Boolean).length < count) {
      const result = await reader.read()
      if (result.done) break
      text += decoder.decode(result.value, { stream: true })
    }
    return text
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await reader.cancel().catch(() => {})
  }
}

// The replay BUFFER is a ticketed capability as of 6.42.0: a ticketless subscriber
// gets `ready`, lifecycle markers and replay-GAP notices, but never the buffered
// events themselves. These tests pin replay ORDERING, which only exists on the
// authorized path, so they connect with a ticket — the behaviour they cover moved,
// it did not disappear. The ticketless half of the gap contract is pinned in
// display-ticketless.test.ts.
const TEST_TOKEN = 'display-reconnect-suite-token'
let previousToken: string | undefined

/** Same cursor query as before, now carried on the ticketed path. */
function streamUrl(base: string, query: string): string {
  return `${base}/api/display-stream/${mintDisplayTicket(TEST_TOKEN)}?${query}`
}

beforeEach(() => {
  previousToken = process.env.COS_API_TOKEN
  process.env.COS_API_TOKEN = TEST_TOKEN
  __resetDisplayBusForTests()
})
afterEach(async () => {
  if (previousToken === undefined) delete process.env.COS_API_TOKEN
  else process.env.COS_API_TOKEN = previousToken
  if (!server) return
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
})

describe('display reconnect protocol', () => {
  it('sends ready before replaying publish-owned events', async () => {
    const base = await startServer()
    emitDisplay({ type: 'done', data: { text: 'complete' } })
    const text = await readFrames(streamUrl(base, `bootId=${serverMetrics.bootId}&eventId=0`), 3)
    expect(text.indexOf('event: ready')).toBeLessThan(text.indexOf('event: done'))
    expect(text).toContain(`id: ${serverMetrics.bootId}:1`)
    // SHAPE-DISCRIMINATING. `toContain('"eventId":1')` passes for BOTH the nested
    // and the flattened payload, which is why a flattened writeEvent survived 19
    // mutations undetected. Every shipped client reads `_cosDisplayCursor` and
    // returns early without it, so parse the frame and assert the NESTING.
    const doneFrame = text.split('\n\n').find(f => f.includes('event: done'))
    expect(doneFrame).toBeDefined()
    const payload = JSON.parse(doneFrame!.split('data: ')[1])
    expect(payload._cosDisplayCursor).toBeDefined()
    expect(payload._cosDisplayCursor.bootId).toBe(serverMetrics.bootId)
    expect(payload._cosDisplayCursor.eventId).toBe(1)
    expect(payload.bootId).toBeUndefined()   // flattened shape must NOT appear
    expect(payload.eventId).toBeUndefined()

    expect(text).toContain('"eventId":1')
  })

  it('reports a typed replay gap for a prior boot cursor', async () => {
    const base = await startServer()
    const text = await readFrames(streamUrl(base, 'bootId=old-boot&eventId=4'), 3)
    expect(text.indexOf('event: ready')).toBeLessThan(text.indexOf('event: replay_gap'))
    expect(text).toContain('"reason":"boot_changed"')
  })
})
