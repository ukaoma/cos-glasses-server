// 6.62.0 provider parity on the session rows (plan 1.1, 1.2, 1.3, 1.9). The working hint the
// lens reads (`running`, `running_active`, `running_foreign`) now follows the engine's own
// evidence for every provider, capped at five minutes after the last event, and stays a
// DISPLAY HINT: none of this touches the write gate (`thread-occupancy.ts`).
//
// Every fixture home is a temp dir with a space and a dot directory in its path.

import express from 'express'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter, runningHintFor } from './agent-sessions.js'
import { __resetSessionHooksForTests, sessionSignalStore } from '../lib/session-hooks-runtime.js'
import { HOOK_ACTIVE_CAP_MS, __resetCodexRolloutStateForTests, codexRolloutReads } from '../lib/codex-rollout-state.js'
import { resetLockSnapshot } from '../lib/occupancy-probes.js'
import type { DerivedSessionState } from '../lib/session-state-derive.js'
import type { HookEnvelope } from '../lib/session-hook-events.js'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const ENV_KEYS = ['COS_AGENT_SESSIONS_HOME', 'CODEX_HOME', 'COS_SESSION_HOOKS', 'COS_CLAUDE_SESSIONS_DIR', 'COS_CLAUDE_SESSIONS_ENABLED'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env.COS_SESSION_HOOKS = '1'
  __resetSessionHooksForTests()
  __resetCodexRolloutStateForTests()
  resetLockSnapshot()
})
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  __resetSessionHooksForTests()
})

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-parity-'))
  roots.push(root)
  const h = join(root, 'Ukaoma Chief Of Staff')
  mkdirSync(join(h, '.claude', 'projects'), { recursive: true })
  mkdirSync(join(h, '.codex', 'sessions'), { recursive: true })
  mkdirSync(join(h, '.cursor', 'projects'), { recursive: true })
  mkdirSync(join(h, '.cursor', 'chats'), { recursive: true })
  process.env.COS_AGENT_SESSIONS_HOME = h
  process.env.CODEX_HOME = join(h, '.codex')
  return h
}

function write(path: string, lines: string[], mtime = new Date()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.join('\n') + '\n')
  utimesSync(path, mtime, mtime)
}

async function server(): Promise<string> {
  const app = express()
  app.use('/api', agentSessionsRouter)
  const listener = await new Promise<ReturnType<typeof app.listen>>(r => { const l = app.listen(0, '127.0.0.1', () => r(l)) })
  closers.push(() => new Promise<void>(r => listener.close(() => r())))
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
}

async function rowAndDetail(base: string, provider: string, id: string): Promise<{ row: Record<string, any>; detail: Record<string, any> }> {
  const list = await (await fetch(`${base}/api/agent-sessions?limit=40`)).json() as { sessions: Array<Record<string, any>> }
  const detail = await (await fetch(`${base}/api/agent-sessions/${provider}/${id}`)).json() as Record<string, any>
  const row = list.sessions.find(s => s.session_id === id)
  if (!row) throw new Error(`${id} not listed`)
  return { row, detail }
}

const env = (sessionId: string, provider: HookEnvelope['provider'], ts: number, event: HookEnvelope['event'], payload: Record<string, unknown> = {}): HookEnvelope =>
  ({ ts, ppid: 1, event, sessionId, provider, payload: { session_id: sessionId, ...payload } })

describe('runningHintFor (pure)', () => {
  const derived = (agent_state: DerivedSessionState['agent_state'], state_source: DerivedSessionState['state_source']): DerivedSessionState =>
    ({ agent_state, state_source, state_since: new Date(0).toISOString(), deadScans: 0, deadSince: null })
  const now = 10_000_000

  it('hook running is active inside the cap, for every provider; Cursor is decided and foreign', () => {
    for (const provider of ['claude', 'codex', 'cursor'] as const) {
      expect(runningHintFor(provider, derived('running', 'hook'), now - 2 * 60_000, now)).toEqual({ running: true, active: true, foreign: provider === 'cursor', decides: provider === 'cursor' })
    }
    expect(runningHintFor('claude', derived('running', 'hook'), now - HOOK_ACTIVE_CAP_MS, now)?.active).toBe(true)
  })

  it('past the cap: no hint for Claude and Codex (occupancy answers), not running for Cursor', () => {
    expect(runningHintFor('claude', derived('running', 'hook'), now - HOOK_ACTIVE_CAP_MS - 1, now)).toBeNull()
    expect(runningHintFor('codex', derived('running', 'hook'), now - 6 * 60_000, now)).toBeNull()
    expect(runningHintFor('cursor', derived('running', 'hook'), now - 6 * 60_000, now)).toEqual({ running: false, active: false, foreign: false, decides: true })
    expect(runningHintFor('cursor', derived('running', 'hook'), null, now)).toEqual({ running: false, active: false, foreign: false, decides: true })
  })

  it('waiting: running, never active; idle and ended: nothing for Claude/Codex, quiet for Cursor', () => {
    expect(runningHintFor('claude', derived('waiting', 'hook'), now - 20 * 60_000, now)).toEqual({ running: true, active: false, foreign: false, decides: false })
    expect(runningHintFor('cursor', derived('waiting', 'hook'), now, now)).toEqual({ running: true, active: false, foreign: true, decides: true })
    for (const s of ['idle', 'ended', 'failed'] as const) {
      expect(runningHintFor('claude', derived(s, 'hook'), now, now)).toBeNull()
      expect(runningHintFor('cursor', derived(s, 'hook'), now, now)).toEqual({ running: false, active: false, foreign: false, decides: true })
    }
  })

  it('only Codex reads a transcript-derived run, inside the cap; registry and other providers never', () => {
    expect(runningHintFor('codex', derived('running', 'transcript'), now - 60_000, now)).toEqual({ running: true, active: true, foreign: false, decides: false })
    expect(runningHintFor('codex', derived('running', 'transcript'), now - 6 * 60_000, now)).toBeNull()
    expect(runningHintFor('claude', derived('running', 'transcript'), now, now)).toBeNull()
    expect(runningHintFor('claude', derived('running', 'registry'), now, now)).toBeNull()
    expect(runningHintFor('cursor', undefined, now, now)).toBeNull()
  })
})

describe('Cursor rows follow the hooks (plan 1.1)', () => {
  const ID = 'bbbbbbbb-1111-2222-3333-cccccccccccc'
  function cursorHome(fileAgoMs = 10 * 60_000): void {
    const h = home()
    write(join(h, '.cursor', 'projects', 'Users-me-Ukaoma-Chief-Of-Staff', 'agent-transcripts', ID, `${ID}.jsonl`), [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Wire the queue</user_query>"}]}}',
    ], new Date(Date.now() - fileAgoMs))
  }
  const turnOpen = (lastAgo: number) => {
    const now = Date.now()
    sessionSignalStore.apply(env(ID, 'cursor', now - lastAgo - 1_000, 'UserPromptSubmit', { prompt: 'Wire the queue', cursor_version: '2026.10.01' }))
    sessionSignalStore.apply(env(ID, 'cursor', now - lastAgo, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, cursor_version: '2026.10.01' }))
  }

  it('a 2-minute gap reads active on list and detail, foreign (an IDE composer), with last_activity_at = the last event', async () => {
    cursorHome()
    turnOpen(2 * 60_000)
    const { row, detail } = await rowAndDetail(await server(), 'cursor', ID)
    for (const r of [row, detail]) {
      expect(r).toMatchObject({ running: true, running_active: true, running_foreign: true, agent_state: 'running', state_source: 'hook' })
      expect(Date.now() - Date.parse(r.last_activity_at)).toBeGreaterThanOrEqual(2 * 60_000)
      expect(Date.now() - Date.parse(r.last_activity_at)).toBeLessThan(2 * 60_000 + 10_000)
    }
  })

  it('6 minutes after the last event (Esc with no Stop): not running, not active', async () => {
    cursorHome()
    turnOpen(6 * 60_000)
    const { row, detail } = await rowAndDetail(await server(), 'cursor', ID)
    // The deriver still says running (inside the 30-minute ceiling); the HINT decays.
    for (const r of [row, detail]) expect(r).toMatchObject({ agent_state: 'running', running: false, running_active: false, running_foreign: false })
  })

  it('a Stop reads not active at once, even with the transcript written seconds ago (the hooks decide, not the file time)', async () => {
    cursorHome(1_000)
    turnOpen(3_000)
    sessionSignalStore.apply(env(ID, 'cursor', Date.now() - 500, 'Stop', { cursor_version: '2026.10.01' }))
    const { row, detail } = await rowAndDetail(await server(), 'cursor', ID)
    for (const r of [row, detail]) expect(r).toMatchObject({ agent_state: 'idle', running: false, running_active: false })
  })

  it('waiting on a permission: running, not active', async () => {
    cursorHome()
    const now = Date.now()
    sessionSignalStore.apply(env(ID, 'cursor', now - 20_000, 'UserPromptSubmit', { prompt: 'x', cursor_version: '1' }))
    sessionSignalStore.apply(env(ID, 'cursor', now - 10_000, 'PermissionRequest', { tool_name: 'Shell', tool_input: { command: 'rm x' }, cursor_version: '1' }))
    const { row, detail } = await rowAndDetail(await server(), 'cursor', ID)
    for (const r of [row, detail]) expect(r).toMatchObject({ agent_state: 'waiting', running: true, running_active: false })
  })

  it('no hook evidence: the detail keeps the 30 s file-time rule, the list stays quiet (6.61 fallback)', async () => {
    cursorHome(1_000)
    const { row, detail } = await rowAndDetail(await server(), 'cursor', ID)
    expect(row).toMatchObject({ running: false, running_active: false })
    expect(row).not.toHaveProperty('last_activity_at')
    expect(detail).toMatchObject({ running: true, running_active: true })
  })
})

describe('Claude: hook evidence counts as active for five minutes (plan 1.2)', () => {
  const ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
  function claudeHome(transcriptAgoMs: number): void {
    const h = home()
    const at = new Date(Date.now() - transcriptAgoMs)
    write(join(h, '.claude', 'projects', 'repo', `${ID}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: at.toISOString(), message: { role: 'user', content: 'Long think' } }),
      JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 120' } }] } }),
    ], at)
    process.env.COS_CLAUDE_SESSIONS_DIR = join(h, '.claude', 'sessions')
  }

  it('a turn with 90 s of silence reads active (6.61 read it merely open)', async () => {
    claudeHome(90_000)
    const now = Date.now()
    sessionSignalStore.apply(env(ID, 'claude', now - 91_000, 'UserPromptSubmit', { prompt: 'Long think' }))
    sessionSignalStore.apply(env(ID, 'claude', now - 90_000, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 120' } }))
    const { row, detail } = await rowAndDetail(await server(), 'claude', ID)
    for (const r of [row, detail]) expect(r).toMatchObject({ agent_state: 'running', state_source: 'hook', running: true, running_active: true })
  })

  it('Esc with no Stop decays: 6 minutes after the last event it is not active', async () => {
    claudeHome(6 * 60_000)
    const now = Date.now()
    sessionSignalStore.apply(env(ID, 'claude', now - 6 * 60_000 - 1_000, 'UserPromptSubmit', { prompt: 'Long think' }))
    sessionSignalStore.apply(env(ID, 'claude', now - 6 * 60_000, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }))
    const { row, detail } = await rowAndDetail(await server(), 'claude', ID)
    for (const r of [row, detail]) expect(r).toMatchObject({ running: false, running_active: false })
  })

  it('no hooks at all: exactly the 6.61 reading (a 90 s old transcript is not active)', async () => {
    claudeHome(90_000)
    const { row, detail } = await rowAndDetail(await server(), 'claude', ID)
    for (const r of [row, detail]) expect(r).toMatchObject({ running: false, running_active: false })
  })
})

describe('Codex rows: the hooks, else the rollout (plan 1.3, 1.9)', () => {
  const ID = '01a10c4b-0000-7000-8000-00000000c0de'
  function rollout(h: string, lines: string[], agoMs = 5_000): string {
    const path = join(h, '.codex', 'sessions', '2026', '10', '05', `rollout-2026-10-05T09-00-00-${ID}.jsonl`)
    write(path, [
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: ID, cwd: '/Users/me/Ukaoma Chief Of Staff', originator: 'Codex Desktop', timestamp: new Date().toISOString() } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the queue' }] } }),
      ...lines,
    ], new Date(Date.now() - agoMs))
    return path
  }
  const started = JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } })
  const complete = JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })

  it('an open turn in a fresh rollout: running and active, source transcript; the read is memoized', async () => {
    rollout(home(), [started])
    const base = await server()
    const { row, detail } = await rowAndDetail(base, 'codex', ID)
    for (const r of [row, detail]) expect(r).toMatchObject({ agent_state: 'running', state_source: 'transcript', running: true, running_active: true, running_foreign: false })
    const reads = codexRolloutReads()
    await rowAndDetail(base, 'codex', ID)
    expect(codexRolloutReads()).toBe(reads)
  })

  it('a completed turn reads idle; an open turn written 6 minutes ago is not active and is never read', async () => {
    rollout(home(), [started, complete])
    const done = await rowAndDetail(await server(), 'codex', ID)
    for (const r of [done.row, done.detail]) expect(r).toMatchObject({ agent_state: 'idle', running: false, running_active: false })
    __resetCodexRolloutStateForTests()
    rollout(home(), [started], 6 * 60_000)
    const cold = await rowAndDetail(await server(), 'codex', ID)
    for (const r of [cold.row, cold.detail]) expect(r).toMatchObject({ agent_state: 'idle', running: false, running_active: false })
    expect(codexRolloutReads()).toBe(0)
  })

  it('Codex hooks win over the rollout, with the same five-minute cap; Interrupt closes the turn', async () => {
    rollout(home(), [started, complete], 4 * 60_000)
    const now = Date.now()
    sessionSignalStore.apply(env(ID, 'codex', now - 2 * 60_000, 'UserPromptSubmit', { prompt: 'again', turn_id: 't2' }))
    const base = await server()
    const open = await rowAndDetail(base, 'codex', ID)
    for (const r of [open.row, open.detail]) expect(r).toMatchObject({ agent_state: 'running', state_source: 'hook', running: true, running_active: true })
    sessionSignalStore.apply(env(ID, 'codex', now - 1_000, 'Interrupt', { turn_id: 't2' }))
    const stopped = await rowAndDetail(base, 'codex', ID)
    for (const r of [stopped.row, stopped.detail]) expect(r).toMatchObject({ agent_state: 'idle', state_source: 'hook', running: false, running_active: false })
  })

  it('compaction: the PreCompact hook opens it on list and detail; the rollout\'s ContextCompaction item closes it', async () => {
    const h = home()
    rollout(h, [started])
    const now = Date.now()
    sessionSignalStore.apply(env(ID, 'codex', now - 30_000, 'UserPromptSubmit', { prompt: 'x', turn_id: 't1' }))
    sessionSignalStore.apply(env(ID, 'codex', now - 20_000, 'PreCompact', { trigger: 'auto', turn_id: 't1' }))
    const base = await server()
    const compacting = await rowAndDetail(base, 'codex', ID)
    for (const r of [compacting.row, compacting.detail]) expect(r.compaction).toMatchObject({ state: 'compacting', started_at: now - 20_000 })
    const item = JSON.stringify({ timestamp: new Date(now - 5_000).toISOString(), type: 'event_msg', payload: { type: 'item_completed', thread_id: ID, turn_id: 't1', item: { type: 'ContextCompaction', id: 'item-9' }, completed_at_ms: now - 5_000 } })
    rollout(h, [started, item], 2_000)
    const done = await rowAndDetail(base, 'codex', ID)
    for (const r of [done.row, done.detail]) expect(r).not.toHaveProperty('compaction')
  })
})

describe('Cursor title: the composer name, else the FIRST query, on list and detail alike (plan 1.6)', () => {
  it('a two-turn chat with no composer name is titled by its first query, not its newest', async () => {
    const ID = 'cccccccc-1111-2222-3333-dddddddddddd'
    const h = home()
    write(join(h, '.cursor', 'projects', 'Users-me-Ukaoma-Chief-Of-Staff', 'agent-transcripts', ID, `${ID}.jsonl`), [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Build the parity suite</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"On it."}]}}',
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>also fix the lint</user_query>"}]}}',
    ])
    const { row, detail } = await rowAndDetail(await server(), 'cursor', ID)
    for (const r of [row, detail]) {
      expect(r.display_label).toBe('Build the parity suite')
      expect(r.first_prompt).toBe('Build the parity suite')
    }
  })
})
