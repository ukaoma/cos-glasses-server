import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 6.99.19: nextEvent.occurrence appears ONLY when the bridge answers the event with provider identity. The bridge
// sends no event ids today, so today's answers are unchanged. The bridge is mocked as in welcome-context-calendar.
const bridge = vi.hoisted(() => ({ answer: (): Promise<unknown> => Promise.resolve({ today_remaining: [] }) }))
vi.mock('../lib/python-bridge.js', () => ({
  pythonBridgeAvailable: () => true,
  callPython: (args: string[]) => { if (args[0] !== 'calendar') throw new Error(`unexpected bridge call ${args[0]}`); return bridge.answer() },
}))

import { _resetWelcomeContextCachesForTests, bridgeOccurrence, welcomeContextRouter } from './welcome-context.js'
import { prepOccurrenceKey } from '../lib/prep-store.js'

let server: Server
let base = ''
beforeAll(async () => {
  const app = express()
  app.use('/api', welcomeContextRouter)
  server = await new Promise<Server>(resolve => { const v = app.listen(0, '127.0.0.1', () => resolve(v)) })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
beforeEach(() => {
  _resetWelcomeContextCachesForTests()
  delete process.env.COS_WEATHER_DEFAULT_LAT
  delete process.env.COS_WEATHER_DEFAULT_LON
})

const soon = () => new Date(Date.now() + 30 * 60_000).toISOString()
async function nextEvent(): Promise<Record<string, unknown>> {
  const body = await (await fetch(`${base}/api/welcome-context`)).json() as Record<string, unknown>
  return body.nextEvent as Record<string, unknown>
}

describe('nextEvent.occurrence (6.99.19)', () => {
  it('is absent for today\'s bridge answer, which carries no event ids', async () => {
    bridge.answer = () => Promise.resolve({ today_remaining: [{ title: 'Pete 1:1', start_time: soon() }] })
    const event = await nextEvent()
    expect(Object.keys(event).sort()).toEqual(['inMinutes', 'time', 'title'])
  })

  it('is present when the bridge supplies provider, calendar id, event id and start', async () => {
    const start = soon()
    bridge.answer = () => Promise.resolve({ today_remaining: [{ title: 'Pete 1:1', start_time: start, provider: 'm365', calendar_id: 'cal-1', event_id: 'evt-9' }] })
    const event = await nextEvent()
    expect(event.occurrence).toEqual({ key: prepOccurrenceKey({ provider: 'm365', account: null, calendarId: 'cal-1', eventId: 'evt-9', externalId: null, startsAt: start }), provider: 'm365', account: null, calendarId: 'cal-1', eventId: 'evt-9', externalId: null, startsAt: start, endsAt: null })
  })

  it('stays absent when any part is missing, including the next_event fallback', async () => {
    bridge.answer = () => Promise.resolve({ next_event: { title: 'Board', start_time: soon(), provider: 'google', calendar_id: 'c' }, minutes_until_next: 30 })
    expect((await nextEvent()).occurrence).toBeUndefined()
    expect(bridgeOccurrence({ title: 'Board', start_time: soon() })).toBeUndefined()
    expect(bridgeOccurrence({ provider: 'google', calendarId: 'c', externalId: 'ical', startsAt: soon() })?.provider).toBe('google')
  })
})
