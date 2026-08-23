import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { healthRouter } from './health.js'

let server: Server | null = null
let base = ''

beforeAll(async () => {
  const app = express()
  app.use('/api', healthRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server!.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})

afterAll(async () => {
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
})

describe('health capability contract', () => {
  it('advertises the exact G2 lens payload variant', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      features?: { g2LensVariant?: string }
    }
    expect(body.features?.g2LensVariant).toBe('png-288x144-v1')
  }, 20_000)

  it('advertises CLI debug without exposing a raw provider session id', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.capabilities?.cliDebug).toEqual({
      schemaVersion: 1,
      providers: { claude: true, codex: true, cursor: true },
      metadataOnly: true,
    })
    expect(typeof body.cli_session_available).toBe('boolean')
    expect(body).not.toHaveProperty('cli_session_id')
  }, 20_000)
})

describe('features.claudeSessions', () => {
  // COS Control's "Show Claude sessions" checkbox sourced its state from
  // GET /api/claude-sessions -- the call that also lists every session -- and the
  // panel never made that call, so the box rendered false while the setting was
  // true. Miles enabled it four times against a control that could only show him
  // one value. Health is what every other panel toggle already reads, and this is
  // a pure env read, so it costs nothing on a poll.
  it('publishes the flag so a client toggle can read its own state', async () => {
    const prev = process.env.COS_CLAUDE_SESSIONS_ENABLED

    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    const on = await (await fetch(`${base}/api/health`)).json()
    expect(on.features.claudeSessions).toBe(true)

    // Anything but a literal '1' is off, matching claudeSessionsEnabled().
    process.env.COS_CLAUDE_SESSIONS_ENABLED = 'true'
    const loose = await (await fetch(`${base}/api/health`)).json()
    expect(loose.features.claudeSessions).toBe(false)

    delete process.env.COS_CLAUDE_SESSIONS_ENABLED
    const off = await (await fetch(`${base}/api/health`)).json()
    expect(off.features.claudeSessions).toBe(false)

    // PRESENT even when off. A client distinguishes false from absent: absent means
    // a server too old to report it, and the toggle must then be left alone rather
    // than forced off.
    expect(Object.keys(off.features)).toContain('claudeSessions')

    if (prev === undefined) delete process.env.COS_CLAUDE_SESSIONS_ENABLED
    else process.env.COS_CLAUDE_SESSIONS_ENABLED = prev
  })
})
