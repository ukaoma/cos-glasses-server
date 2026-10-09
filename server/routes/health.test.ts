import express from 'express'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { DISPLAY_TICKET_TTL_SECONDS, verifyDisplayTicket } from '../lib/display-ticket.js'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installClaudeHooks } from '../lib/claude-hooks-installer.js'
import { invalidateHookStatus } from '../lib/session-hooks-runtime.js'
import { installCodexHooks } from '../lib/codex-hooks-installer.js'
import { installCursorObserver } from '../lib/cursor-observer-installer.js'
import { __resetProviderObserveForTests, refreshProviderHookFiles } from '../lib/provider-observe.js'
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

  it('readiness.diarizer says what labels a chunk now, with the outcome counts', async () => {
    const response = await fetch(`${base}/api/health`)
    const body = await response.json() as any
    // The suite runs with COS_DIARIZER=embedding (vitest.config.ts): the voiceprint by choice, not a fallback.
    expect(body.readiness.diarizer).toMatchObject({
      requested: 'embedding',
      active: 'embedding',
      fallback: null,
      variant: 'fast32',
      budgetMs: 1500,
      chunks: { nemotron: 0, voiceprint: 0, reasons: {} },
      final: { last: null, counts: {} },
    })
    expect(body.readiness.status).toBe(body.readiness.whisper === 'degraded' || body.readiness.speakerId === 'degraded' ? 'degraded' : 'ready')
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

  // 6.67.0: clients check this before any pairing call; an older server omits it.
  it('advertises glasses pairing version 1 on the public health route', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.capabilities?.pairing).toEqual({ version: 1 })
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
      // 6.62.0: deskCursor follows the Claude hooks Cursor runs; deskCodex needs Codex's own
      // trusted hooks, which nothing here installs.
      expect(before.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: false, deskCodex: false, deskCursor: false })
      expect(installClaudeHooks({ port: 3999 }).status.state).toBe('installed')
      invalidateHookStatus()
      const installed = await (await fetch(`${base}/api/health`)).json()
      expect(installed.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: true, deskCodex: false, deskCursor: true })
      // 6.53.3: the update changed the script. An install still on the 6.53.0 script reads
      // script_outdated (Control's banner asks for Install hooks) but can stop desk runs,
      // so deskClaude stays true; a script older than the halt check cannot.
      const stable = join(root, '.cos-glasses', 'bin', 'cos-session-hook')
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', '__fixtures__', 'cos-session-hook-6.53.0'), stable)
      invalidateHookStatus()
      const prior = await (await fetch(`${base}/api/health`)).json()
      expect(prior.sessionHooks.state).toBe('script_outdated')
      // QA W1: a halt-capable EARLIER script stops desk Claude runs, never Cursor ones: it reads
      // the first session_id, which Cursor writes behind tool_input.
      expect(prior.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: true, deskCodex: false, deskCursor: false })
      // 6.62.0 (B1): the 6.61.7 script next to this package is the Mac right after Update
      // Server and before Install hooks. Desk cancel must not turn off in that window.
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', '__fixtures__', 'cos-session-hook-6.61.7'), stable)
      invalidateHookStatus()
      const upgraded = await (await fetch(`${base}/api/health`)).json()
      expect(upgraded.sessionHooks.state).toBe('script_outdated')
      expect(upgraded.sessionHooks.installed).toBe(false)
      expect(upgraded.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: true, deskCodex: false, deskCursor: false })
      writeFileSync(stable, '#!/bin/sh\n# a 6.51 script, no halt check\nexit 0\n')
      invalidateHookStatus()
      const older = await (await fetch(`${base}/api/health`)).json()
      expect(older.sessionHooks.state).toBe('script_outdated')
      expect(older.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: false, deskCodex: false, deskCursor: false })
      process.env.COS_SESSION_HOOKS = '0'
      const off = await (await fetch(`${base}/api/health`)).json()
      expect(off.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: false, deskCodex: false, deskCursor: false })
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
      invalidateHookStatus()
    }
  }, 20_000)
})

// 6.62.0 (B2, plan 1.10): Codex and the Cursor observer are reported APART from Claude's
// fields, and `providers.<engine>.observe` names where each observation comes from. With no
// background refresh started (no test starts one) nothing is read from a home directory.
describe('provider observation on health (6.62.0)', () => {
  it('health and models preserve actions alongside observation, including provider limits', async () => {
    const health = await (await fetch(`${base}/api/health`)).json() as any
    const models = await (await fetch(`${base}/api/models`)).json() as any
    const capabilities = ['approvals', 'cancelDesk', 'continueBusy', 'continueIdle', 'fork', 'keepModel', 'nativeQueue', 'permissions']
    for (const body of [health, models]) {
      for (const provider of ['claude', 'codex', 'cursor']) {
        expect(Object.keys(body.providers[provider].act).sort()).toEqual(capabilities)
        expect(body.providers[provider].observe.liveState).toEqual(expect.any(String))
        for (const capability of Object.values(body.providers[provider].act) as any[]) {
          expect(typeof capability.supported).toBe('boolean')
          if (!capability.supported) expect(capability.reason).toEqual(expect.any(String))
        }
      }
      expect(body.providers.cursor.act.approvals).toEqual({ supported: false, reason: 'engine_limit' })
      expect(body.providers.cursor.act.nativeQueue).toEqual({ supported: false, reason: 'engine_limit' })
      expect(body.providers.codex.act.nativeQueue).toEqual({ supported: true })
    }
    expect(models.providers).toEqual(health.providers)
  }, 20_000)

  it('sessionHooks.codex and cursorObserver sit beside the Claude fields; providers.*.observe has the five sources', async () => {
    __resetProviderObserveForTests()
    const body = await (await fetch(`${base}/api/health`)).json() as any
    expect(body.sessionHooks.codex).toEqual({ present: false, installed: false, state: null, trust: 'unknown', trustReason: 'not_installed', scriptOk: false, checkedAt: null, trustCheckedAt: null })
    expect(body.sessionHooks.cursorObserver).toEqual({ installed: false, nodeOk: false, checkedAt: null })
    // Claude's own words are exactly where and what they were.
    expect(['installed', 'drift', 'missing', 'script_outdated', 'disabled_by_settings', 'settings_unparseable', 'settings_symlink', 'settings_unreadable']).toContain(body.sessionHooks.state)
    expect(body.sessionHooks.installed).toBe(body.sessionHooks.state === 'installed')
    for (const provider of ['claude', 'codex', 'cursor']) {
      expect(Object.keys(body.providers[provider].observe).sort()).toEqual(['children', 'compaction', 'hooks', 'liveState', 'reasoning'])
      for (const v of Object.values(body.providers[provider].observe)) expect(typeof v).toBe('string')
    }
    expect(body.providers.claude.observe.reasoning).toBe('none')
    expect(body.providers.codex.observe).toMatchObject({ hooks: 'absent', liveState: 'transcript', children: 'state_db', compaction: 'rollout_end', reasoning: 'rollout' })
    expect(body.providers.cursor.observe).toMatchObject({ children: 'none', reasoning: 'none' })
  }, 20_000)

  it('the snapshot, once refreshed against scratch homes, says installed and the sources follow', async () => {
    const keys = ['CODEX_HOME', 'CURSOR_CONFIG_DIR', 'COS_GLASSES_HOME', 'CLAUDE_CONFIG_DIR', 'COS_SESSION_HOOKS', 'COS_CODEX_BIN'] as const
    const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-health-observe-')))
    const home = join(root, 'Ukaoma Chief Of Staff')
    // A stand-in Codex binary, so "Codex is present" does not depend on this Mac. It is never run.
    const fakeCodex = join(home, 'Fake Codex', 'codex')
    mkdirSync(dirname(fakeCodex), { recursive: true })
    writeFileSync(fakeCodex, '#!/bin/sh\nexit 1\n')
    chmodSync(fakeCodex, 0o755)
    process.env.COS_CODEX_BIN = fakeCodex
    process.env.CODEX_HOME = join(home, '.codex')
    process.env.CURSOR_CONFIG_DIR = join(home, '.cursor')
    process.env.COS_GLASSES_HOME = join(home, '.cos-glasses')
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
    process.env.COS_SESSION_HOOKS = '1'
    mkdirSync(process.env.CODEX_HOME, { recursive: true })
    try {
      __resetProviderObserveForTests()
      expect(installCursorObserver().ok).toBe(true)
      expect(installCodexHooks().ok).toBe(true)
      invalidateHookStatus()
      refreshProviderHookFiles()
      // Codex installed, Claude not yet: Claude's words stay Claude's (B2), nothing leaks across.
      const codexOnly = await (await fetch(`${base}/api/health`)).json() as any
      expect(codexOnly.sessionHooks.codex).toMatchObject({ present: true, installed: true, scriptOk: true, trust: 'unknown', trustReason: 'unchecked' })
      expect(codexOnly.sessionHooks.state).toBe('missing')
      expect(codexOnly.sessionHooks.installed).toBe(false)
      expect(codexOnly.features.sessionCancel).toMatchObject({ deskClaude: false, deskCodex: false, deskCursor: false })
      expect(installClaudeHooks({ port: 3999 }).ok).toBe(true)
      invalidateHookStatus()
      const body = await (await fetch(`${base}/api/health`)).json() as any
      expect(body.sessionHooks.cursorObserver).toMatchObject({ installed: true, nodeOk: true })
      expect(typeof body.sessionHooks.cursorObserver.checkedAt).toBe('string')
      expect(body.providers.cursor.observe).toEqual({ hooks: 'claude_hooks', liveState: 'hook', children: 'observer', compaction: 'observer', reasoning: 'observer' })
      // Installed but not yet trusted by Codex: never a desk cancel, and said as `unknown`.
      expect(body.sessionHooks.codex).toMatchObject({ present: true, installed: true, scriptOk: true, trust: 'unknown' })
      expect(body.providers.codex.observe).toMatchObject({ hooks: 'unknown', liveState: 'transcript', compaction: 'rollout_end' })
      expect(body.features.sessionCancel).toEqual({ cosTurn: true, deskClaude: true, deskCodex: false, deskCursor: true })
      expect(body.sessionHooks.state).toBe('installed')
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
      __resetProviderObserveForTests()
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
    expect(body.capabilities?.dictationCleanup).toEqual({ models: ['haiku', 'sonnet', 'luna-5.6-fast'] })
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
