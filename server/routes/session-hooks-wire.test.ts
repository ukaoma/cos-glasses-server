// The additive state fields on the wire (6.48.0): `/api/claude-sessions` peers and the
// session-hooks status route. The `toPeer` key set stays pinned in claude-sessions.test.ts;
// this file pins what is ADDED on top of it and that an unhooked session adds nothing
// beyond what the registry alone can say.

import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeSessionsRouter } from './claude-sessions.js'
import { createSessionHooksRouter } from './session-hooks.js'
import { __resetSessionHooksForTests, sessionSignalStore } from '../lib/session-hooks-runtime.js'
import { parseHookEnvelope } from '../lib/session-hook-events.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', '__fixtures__', 'session-hooks-6.48.0')
const envelopes = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8').split('\n').filter(Boolean).map(l => {
  const p = parseHookEnvelope(l)
  if (!p.ok) throw new Error(p.reason)
  return p.envelope
})

describe('derived state on the claude-sessions wire', () => {
  const closers: Array<() => Promise<void>> = []
  const saved: Record<string, string | undefined> = {}
  let dir: string
  const recorded = envelopes('post-tool-use.hooks.jsonl')
  const sessionId = recorded[0].sessionId

  beforeEach(() => {
    for (const k of ['COS_CLAUDE_SESSIONS_ENABLED', 'COS_CLAUDE_SESSIONS_DIR', 'COS_SESSION_HOOKS']) saved[k] = process.env[k]
    const parent = mkdtempSync(join(tmpdir(), 'cos-hooks-wire-'))
    dir = resolve(parent, 'sessions')
    mkdirSync(dir, { recursive: true })
    // The registry record for the recorded session: alive, busy, moved before the hooks did.
    writeFileSync(join(dir, '4242.json'), JSON.stringify({
      pid: process.pid, sessionId, cwd: '/Users/example/project', startedAt: recorded[0].ts - 1000,
      version: '2.1.272', kind: 'interactive', entrypoint: 'claude-desktop', name: 'project-ab', nameSource: 'derived',
      status: 'busy', updatedAt: recorded[1].ts - 1, statusUpdatedAt: recorded[1].ts - 1,
    }))
    process.env.COS_CLAUDE_SESSIONS_DIR = dir
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    process.env.COS_SESSION_HOOKS = '1'
    __resetSessionHooksForTests()
  })

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    __resetSessionHooksForTests()
  })

  async function start(): Promise<string> {
    const app = express()
    app.use(express.json())
    app.use('/api', claudeSessionsRouter)
    app.use('/api', createSessionHooksRouter({ port: 3141 }))
    const server = await new Promise<ReturnType<typeof app.listen>>(r => { const l = app.listen(0, '127.0.0.1', () => r(l)) })
    closers.push(() => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('stamps agent_state and its provenance on the peer once the hooks have spoken, and only the registry before', async () => {
    const base = await start()
    const before = (await (await fetch(`${base}/api/claude-sessions`)).json()) as { peers: Array<Record<string, unknown>> }
    expect(before.peers[0]).toMatchObject({ id: sessionId.slice(0, 8), agent_state: 'running', state_source: 'registry' })
    expect(before.peers[0]).not.toHaveProperty('waiting_kind')

    for (const env of recorded.slice(0, 3)) sessionSignalStore.apply(env) // start, prompt, permission request
    const during = (await (await fetch(`${base}/api/claude-sessions`)).json()) as { peers: Array<Record<string, unknown>> }
    expect(during.peers[0]).toMatchObject({
      agent_state: 'waiting',
      state_source: 'hook',
      waiting_kind: 'permission',
      waiting_detail: 'Bash touch par-a',
      state_since: new Date(recorded[2].ts).toISOString(),
    })
    // The wire keeps the thirteen pinned peer keys; the eight extras are the only additions.
    const keys = Object.keys(during.peers[0]).sort()
    expect(keys.filter(k => !['agent_state', 'state_source', 'state_since', 'waiting_kind', 'waiting_detail', 'failure', 'last_reply', 'pending_permission_id'].includes(k))).toEqual([
      'alive', 'entrypoint', 'id', 'kind', 'lastActiveAt', 'name', 'nameRedacted', 'reachable', 'startedAt', 'status', 'version', 'waitingFor', 'workspace',
    ])

    for (const env of recorded.slice(3)) sessionSignalStore.apply(env) // through Stop and SessionEnd
    const after = (await (await fetch(`${base}/api/claude-sessions`)).json()) as { peers: Array<Record<string, unknown>> }
    // The registry record is still alive: the SessionEnd was a child's, the tab reads idle.
    expect(after.peers[0]).toMatchObject({ agent_state: 'idle', state_source: 'hook', last_reply: 'done' })
    expect(after.peers[0]).not.toHaveProperty('waiting_kind')
  })

  it('serves status and today\'s runs', async () => {
    const base = await start()
    for (const env of recorded) sessionSignalStore.apply(env)
    const status = (await (await fetch(`${base}/api/session-hooks/status`)).json()) as { ok: boolean; sessionHooks: Record<string, unknown> }
    expect(status.ok).toBe(true)
    expect(status.sessionHooks).toMatchObject({ enabled: true, signals: 1 })
    expect(['installed', 'drift', 'missing', 'script_outdated', 'settings_unparseable', 'settings_symlink']).toContain(status.sessionHooks.installed)
    const runs = (await (await fetch(`${base}/api/session-hooks/runs?since=${recorded[0].ts - 1}`)).json()) as { runs: Array<Record<string, unknown>> }
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0]).toMatchObject({ session_id: sessionId, end_reason: 'other', keep_warm: false, last_reply: 'done' })
  })
})
