import express from 'express'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { DISPLAY_TICKET_TTL_SECONDS, verifyDisplayTicket } from '../lib/display-ticket.js'
import { copyFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installClaudeHooks } from '../lib/claude-hooks-installer.js'
import { invalidateHookStatus } from '../lib/session-hooks-runtime.js'
import { healthRouter } from './health.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

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

describe('morning brief capability', () => {
  it('advertises the scheduler and a public status summary with no prompt or ids', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.features.morningBrief).toBe(true)
    expect(body.capabilities.morningBrief).toMatchObject({ protocolVersion: 1, enabled: true, time: '07:00' })
    expect(typeof body.capabilities.morningBrief.timezone).toBe('string')
    expect(['ready', 'disabled', 'durable_jobs_off', 'admissions_closed']).toContain(body.capabilities.morningBrief.gate)
    const keys = Object.keys(body.capabilities.morningBrief)
    expect(keys).not.toContain('sessionId')
    expect(keys).not.toContain('jobId')
    expect(keys).not.toContain('prompt')
  }, 20_000)
})

describe('features.sessionCancel (6.53.0)', () => {
  // The app shows Cancel run only when the server can carry it out. `deskClaude` must follow
  // the real install state, so this drives a real install into a scratch settings file and
  // a scratch COS home (never the real ~/.claude or ~/.cos-glasses).
  it('cosTurn always; deskClaude only with the hooks applied and the 6.53 hook installed', async () => {
    const keys = ['CLAUDE_CONFIG_DIR', 'COS_GLASSES_HOME', 'COS_SESSION_HOOKS'] as const
    const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-health-cancel-')))
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
    process.env.COS_GLASSES_HOME = join(root, '.cos-glasses')
    process.env.COS_SESSION_HOOKS = '1'
    try {
      invalidateHookStatus()
      const before = await (await fetch(`${base}/api/health`)).json()
      expect(before.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: false })
      expect(installClaudeHooks({ port: 3999 }).status.state).toBe('installed')
      invalidateHookStatus()
      const installed = await (await fetch(`${base}/api/health`)).json()
      expect(installed.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: true })
      // 6.53.3: the update changed the script. An install still on the 6.53.0 script reads
      // script_outdated (Control's banner asks for Install hooks) but can stop desk runs,
      // so deskClaude stays true; a script older than the halt check cannot.
      const stable = join(root, '.cos-glasses', 'bin', 'cos-session-hook')
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', '__fixtures__', 'cos-session-hook-6.53.0'), stable)
      invalidateHookStatus()
      const prior = await (await fetch(`${base}/api/health`)).json()
      expect(prior.sessionHooks.state).toBe('script_outdated')
      expect(prior.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: true })
      writeFileSync(stable, '#!/bin/sh\n# a 6.51 script, no halt check\nexit 0\n')
      invalidateHookStatus()
      const older = await (await fetch(`${base}/api/health`)).json()
      expect(older.sessionHooks.state).toBe('script_outdated')
      expect(older.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: false })
      process.env.COS_SESSION_HOOKS = '0'
      const off = await (await fetch(`${base}/api/health`)).json()
      expect(off.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: false })
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
      invalidateHookStatus()
    }
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

/**
 * The display-stream capability had ZERO coverage when it shipped: deleting the mint
 * line from /api/models and the capability block from /health left the whole suite
 * green, so nothing anywhere proved a client could obtain a working ticket.
 */
describe('display-stream capability advertisement', () => {
  const TOKEN = 'health-suite-display-token'
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env.COS_API_TOKEN
    process.env.COS_API_TOKEN = TOKEN
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.COS_API_TOKEN
    else process.env.COS_API_TOKEN = previous
  })

  it('hands /api/models callers a ticket the verifier accepts', async () => {
    const response = await fetch(`${base}/api/models`)
    expect(response.status).toBe(200)
    const body = await response.json() as { displayStreamTicket?: unknown }
    expect(typeof body.displayStreamTicket).toBe('string')
    // The end-to-end claim: this exact string opens a content-bearing stream.
    // Asserting only that a string is present would pass on a placeholder.
    expect(verifyDisplayTicket(TOKEN, body.displayStreamTicket)).toBe(true)
    // ...and it is bound to THIS server's token, not usable after a rotation.
    expect(verifyDisplayTicket(`${TOKEN}-rotated`, body.displayStreamTicket)).toBe(false)
  }, 30_000)

  it('omits the ticket entirely when the server has no API token', async () => {
    delete process.env.COS_API_TOKEN
    const body = await (await fetch(`${base}/api/models`)).json() as Record<string, unknown>
    // A ticket keyed on '' can never verify, so publishing one would advertise a
    // dead capability. Absent is the honest answer.
    expect(body).not.toHaveProperty('displayStreamTicket')
  }, 30_000)

  it('advertises the capability on the PUBLIC health route', async () => {
    // A client deciding whether to ask for a ticket may not hold a usable token
    // yet, and an old server simply omits the key — which is how a new client
    // detects support at all.
    const body = await (await fetch(`${base}/api/health`)).json() as any
    expect(body.capabilities?.displayStream).toEqual({
      ticketSupported: true,
      ticketTtlSeconds: DISPLAY_TICKET_TTL_SECONDS,
      contentRequiresTicket: true,
    })
    // The advertised TTL is the one the verifier actually enforces, not a literal
    // that can drift away from it.
    expect(body.capabilities.displayStream.ticketTtlSeconds).toBe(900)
  }, 30_000)

  it('never puts a ticket on the public health route', async () => {
    const body = await (await fetch(`${base}/api/health`)).json() as Record<string, unknown>
    expect(body).not.toHaveProperty('displayStreamTicket')
    expect(JSON.stringify(body)).not.toContain(TOKEN)
  }, 30_000)
})
