import express from 'express'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetDisplayBusForTests, emitDisplay } from '../lib/display-bus.js'
import { serverMetrics } from '../lib/server-metrics.js'
import { displayRouter } from './display.js'

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

beforeEach(() => __resetDisplayBusForTests())
afterEach(async () => {
  if (!server) return
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
})

describe('display reconnect protocol', () => {
  it('sends ready before replaying publish-owned events', async () => {
    const base = await startServer()
    emitDisplay({ type: 'done', data: { text: 'complete' } })
    const text = await readFrames(`${base}/api/display-stream?bootId=${serverMetrics.bootId}&eventId=0`, 3)
    expect(text.indexOf('event: ready')).toBeLessThan(text.indexOf('event: done'))
    expect(text).toContain(`id: ${serverMetrics.bootId}:1`)
    expect(text).toContain('"eventId":1')
  })

  it('reports a typed replay gap for a prior boot cursor', async () => {
    const base = await startServer()
    const text = await readFrames(`${base}/api/display-stream?bootId=old-boot&eventId=4`, 3)
    expect(text.indexOf('event: ready')).toBeLessThan(text.indexOf('event: replay_gap'))
    expect(text).toContain('"reason":"boot_changed"')
  })
})
