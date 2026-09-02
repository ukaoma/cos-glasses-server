import express from 'express'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Partial mock: keep the real bus, spy on the ONE call whose argument the route
// decides. `materialize` has no observable output on the socket (the write is
// separately guarded), so the caller's decision is the only thing to pin.
vi.mock('../lib/display-bus.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/display-bus.js')>()
  return { ...actual, replayDisplayEvents: vi.fn(actual.replayDisplayEvents) }
})

import { __resetDisplayBusForTests, emitDisplay, replayDisplayEvents } from '../lib/display-bus.js'
import { mintDisplayTicket } from '../lib/display-ticket.js'
import { __resetDisplayStreamLogForTests, displayRouter } from './display.js'

const TOKEN = 'connect-contract-token'
let server: Server | null = null
let previousToken: string | undefined

async function startServer(): Promise<string> {
  const app = express()
  app.use(express.json())
  app.use('/api', displayRouter)
  server = createServer(app)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

async function handshake(url: string, headers: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const response = await fetch(url, { signal: controller.signal, headers })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 600
    while (Date.now() < deadline) {
      const race = await Promise.race([reader.read(), new Promise<null>(r => setTimeout(() => r(null), 200))])
      if (!race || race.done) break
      text += decoder.decode(race.value, { stream: true })
    }
    await reader.cancel().catch(() => {})
    return text
  } finally {
    clearTimeout(timeout)
  }
}

beforeEach(() => {
  previousToken = process.env.COS_API_TOKEN
  process.env.COS_API_TOKEN = TOKEN
  __resetDisplayBusForTests()
  __resetDisplayStreamLogForTests()
  vi.mocked(replayDisplayEvents).mockClear()
})

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
  if (previousToken === undefined) delete process.env.COS_API_TOKEN
  else process.env.COS_API_TOKEN = previousToken
})

describe('the replay buffer is materialised only for a subscriber it will be written to', () => {
  it('an authorized probe=1 asks for materialize:false; an authorized consumer asks for true; ticketless asks for false', async () => {
    const base = await startServer()
    emitDisplay({ type: 'chunk', data: { text: 'buffered' } })
    await handshake(`${base}/api/display-stream?probe=1`, { 'X-Cos-Token': TOKEN })
    await handshake(`${base}/api/display-stream/${mintDisplayTicket(TOKEN)}`)
    await handshake(`${base}/api/display-stream`)
    const options = vi.mocked(replayDisplayEvents).mock.calls.map(call => call[2]?.materialize)
    expect(options).toEqual([false, true, false])
  })
})

describe('ready is the first frame on every socket', () => {
  // Both clients seed their replay cursor from `ready` and classify anything at
  // or below its watermark as initial replay. That only works if `ready` is
  // written before any replayed event — pin the ordering the clients rely on.
  it('precedes the replay for a ticketed subscriber with a non-empty buffer', async () => {
    const base = await startServer()
    for (let i = 0; i < 3; i++) emitDisplay({ type: 'transcript_chunk', data: { text: `t${i}`, speaker: 'MU' } })
    const text = await handshake(`${base}/api/display-stream/${mintDisplayTicket(TOKEN)}`)
    const firstEvent = text.indexOf('event: ')
    expect(firstEvent).toBeGreaterThanOrEqual(0)
    expect(text.slice(firstEvent, firstEvent + 'event: ready'.length)).toBe('event: ready')
    expect(text.indexOf('event: ready')).toBeLessThan(text.indexOf('event: transcript_chunk'))
  })
  it('precedes the projected event for a ticketless subscriber', async () => {
    const base = await startServer()
    const text = await handshake(`${base}/api/display-stream`)
    expect(text).toContain('event: ready')   // an empty read must FAIL, not pass with -1 === -1
    expect(text.indexOf('event: ready')).toBe(text.indexOf('event: '))
  })

  it('the materialize term and the write guard use the same probe test (shape pin for the "must match" comment)', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./display.ts', import.meta.url), 'utf8')
    expect(source.split("req.query.probe !== '1'").length - 1).toBe(2)
  })
})
