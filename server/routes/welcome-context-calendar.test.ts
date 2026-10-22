import express from 'express'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 6.84.1: `calendarRead` on GET /api/welcome-context. The bridge is mocked: `ready` stands for
// COS_SCRIPTS_DIR with its venv and bridge script; without it callPython answers the no-op.
const bridge = vi.hoisted(() => ({
  ready: true,
  answer: (): Promise<unknown> => Promise.resolve({ today_remaining: [] }),
  noop: (): unknown => ({ events: [] }),
  calls: 0,
}))
vi.mock('../lib/python-bridge.js', () => ({
  pythonBridgeAvailable: () => bridge.ready,
  callPython: (args: string[]) => {
    bridge.calls++
    if (args[0] !== 'calendar') throw new Error(`unexpected bridge call ${args[0]}`)
    // Standalone: the real callPython resolves its no-op shape without touching Python.
    return bridge.ready ? bridge.answer() : Promise.resolve(bridge.noop())
  },
}))

import { _resetWelcomeContextCachesForTests, calendarAnswerWasRead, welcomeContextRouter } from './welcome-context.js'

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use('/api', welcomeContextRouter)
  server = await new Promise<Server>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const realFetch = globalThis.fetch

beforeEach(() => {
  _resetWelcomeContextCachesForTests()
  delete process.env.COS_WEATHER_DEFAULT_LAT
  delete process.env.COS_WEATHER_DEFAULT_LON
  delete process.env.COS_WEATHER_DEFAULT_CITY
  bridge.ready = true
  bridge.calls = 0
  bridge.answer = () => Promise.resolve({ today_remaining: [] })
  bridge.noop = () => ({ events: [] })
})

afterEach(() => {
  vi.useRealTimers()
  _resetWelcomeContextCachesForTests()
})

/** No coordinates are sent, so weather never leaves this Mac; the request itself uses the real fetch. */
async function welcome(): Promise<Record<string, unknown>> {
  const response = await realFetch(`${base}/api/welcome-context`)
  expect(response.status).toBe(200)
  return await response.json() as Record<string, unknown>
}

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

describe('GET /api/welcome-context calendarRead', () => {
  it('is true with the next event when the calendar was read, and adds nothing else', async () => {
    bridge.answer = () => Promise.resolve({ today_remaining: [{ title: 'Pipeline review', start_time: inMinutes(30) }] })
    const body = await welcome()
    expect(Object.keys(body).sort()).toEqual(['calendarRead', 'nextEvent'])
    expect(body.calendarRead).toBe(true)
    expect(body.nextEvent).toMatchObject({ title: 'Pipeline review', inMinutes: expect.any(Number) })
  })

  it('is true for an empty calendar (no more events today is a real answer)', async () => {
    const body = await welcome()
    expect(body).toEqual({ calendarRead: true })
  })

  it('is false when the read throws', async () => {
    bridge.answer = () => Promise.reject(new Error('python-bridge: Traceback'))
    expect(await welcome()).toEqual({ calendarRead: false })
  })

  it('is false when the read times out, whether the bridge reports its deadline or the call is killed', async () => {
    bridge.answer = () => Promise.resolve({ error: 'calendar_unavailable', reason: 'calendar_timeout', deadline_seconds: 8 })
    expect(await welcome()).toEqual({ calendarRead: false })
    _resetWelcomeContextCachesForTests()
    bridge.answer = () => Promise.reject(new Error('python-bridge: Command failed: timed out'))
    expect(await welcome()).toEqual({ calendarRead: false })
  })

  it('is false without a COS pipeline (COS_SCRIPTS_DIR unset), although the no-op answer looks empty', async () => {
    bridge.ready = false
    const body = await welcome()
    expect(body).toEqual({ calendarRead: false })
    expect(bridge.calls).toBe(1)
  })

  it('keeps the flag of the read a cached event came from, and is false for a stale event served after a failed read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T14:00:00Z'))
    bridge.answer = () => Promise.resolve({ today_remaining: [{ title: 'Standup', start_time: inMinutes(45) }] })
    expect(await welcome()).toMatchObject({ calendarRead: true, nextEvent: { title: 'Standup' } })
    bridge.answer = () => Promise.reject(new Error('must not be called inside the cache window'))
    expect(await welcome()).toMatchObject({ calendarRead: true, nextEvent: { title: 'Standup' } })
    expect(bridge.calls).toBe(1)

    vi.setSystemTime(new Date('2026-10-22T14:03:00Z'))
    bridge.answer = () => Promise.reject(new Error('python-bridge: Traceback'))
    const stale = await welcome()
    expect(stale).toMatchObject({ calendarRead: false, nextEvent: { title: 'Standup' } })
    expect(bridge.calls).toBe(2)
  })
})

describe('calendarRead on a cached event that no bridge read', () => {
  it('stays false inside the cache window when the event came from the standalone answer', async () => {
    // A standalone answer that carries an event (as a file-backed calendar could) is still not a read.
    bridge.ready = false
    bridge.noop = () => ({ today_remaining: [{ title: 'From a file', start_time: inMinutes(20) }] })
    expect(await welcome()).toMatchObject({ calendarRead: false, nextEvent: { title: 'From a file' } })
    expect(await welcome()).toMatchObject({ calendarRead: false, nextEvent: { title: 'From a file' } })
    expect(bridge.calls).toBe(1)
  })
})

describe('calendarAnswerWasRead', () => {
  it('needs the bridge and a calendar object without an error', () => {
    expect(calendarAnswerWasRead(true, { today_remaining: [] })).toBe(true)
    expect(calendarAnswerWasRead(true, {})).toBe(true)
    expect(calendarAnswerWasRead(false, { today_remaining: [] })).toBe(false)
    expect(calendarAnswerWasRead(true, null)).toBe(false)
    expect(calendarAnswerWasRead(true, [])).toBe(false)
    expect(calendarAnswerWasRead(true, 'text')).toBe(false)
    expect(calendarAnswerWasRead(true, { error: { code: 'cos_pipeline_not_configured' } })).toBe(false)
  })
})
