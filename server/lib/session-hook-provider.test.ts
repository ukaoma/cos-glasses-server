// 6.62.0 provider parity: the hook pipeline now carries WHICH ENGINE ran a hook (Claude,
// Codex, Cursor) from the spool envelope through the ledger and back out of a replay, and
// understands two events no Claude Code hook fires (Codex's Interrupt, the Cursor
// observer's AgentThought). Every fixture path here has a space and a dot directory, as the
// real repo path and `~/.cos-glasses` do.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AGENT_THOUGHT_MAX, inferHookProvider, parseHookEnvelope, projectHookPayload, type HookEnvelope } from './session-hook-events.js'
import { SessionHookLedger } from './session-hook-ledger.js'
import { applyHookEvent, SessionSignalStore, type SessionSignal } from './session-signal-store.js'
import { deriveSessionState } from './session-state-derive.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-hook-provider-'))
  roots.push(root)
  const dir = join(root, 'Ukaoma Chief Of Staff', '.cos-glasses', 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

const CODEX = '01a10c4b-0000-7000-8000-00000000c0de'
const CURSOR = '8c149bba-82b6-4b73-9f2f-eb26e72a72a9'
const CLAUDE = 'a1b2c3d4-0000-4000-8000-00000000abcd'
const noSpawn = { isCosSpawnedPid: () => false }
const line = (o: Record<string, unknown>) => JSON.stringify(o)

describe('inferHookProvider (plan 2.1 order)', () => {
  it('the envelope stamp first, then cursor_version, then a Codex rollout path, else Claude', () => {
    expect(inferHookProvider('codex', { cursor_version: '1' })).toBe('codex')
    expect(inferHookProvider('cursor', {})).toBe('cursor')
    expect(inferHookProvider(undefined, { cursor_version: '2026.10.01', transcript_path: '/Users/x/.codex/sessions/r.jsonl' })).toBe('cursor')
    expect(inferHookProvider(undefined, { transcript_path: '/Users/x/.codex/sessions/2026/10/05/rollout-x.jsonl' })).toBe('codex')
    expect(inferHookProvider(undefined, { transcript_path: '/Users/x/.claude/projects/p/x.jsonl' })).toBe('claude')
    expect(inferHookProvider('gemini', {})).toBe('claude')
    expect(inferHookProvider(undefined, { transcript_path: null })).toBe('claude')
  })
})

describe('provider survives parse, ledger and replay', () => {
  it('parse keeps the stamp, infers the rest; the ledger row carries it; a replay restores it', () => {
    const codex = parseHookEnvelope(line({ ts: 1_790_000_000_000, ppid: 7, event: 'Stop', provider: 'codex', payload: { session_id: CODEX, turn_id: 't-1', model: 'gpt-6.1-sol', last_assistant_message: 'done' } }))
    const cursor = parseHookEnvelope(line({ ts: 1_790_000_000_001, ppid: 7, event: 'UserPromptSubmit', payload: { conversation_id: CURSOR, session_id: CURSOR, cursor_version: '2026.10.01', prompt: 'hi' } }))
    const claude = parseHookEnvelope(line({ ts: 1_790_000_000_002, ppid: 7, event: 'Stop', payload: { session_id: CLAUDE } }))
    expect(codex.ok && codex.envelope.provider).toBe('codex')
    expect(cursor.ok && cursor.envelope.provider).toBe('cursor')
    expect(claude.ok && claude.envelope.provider).toBe('claude')

    const ledger = new SessionHookLedger(join(dataDir(), 'session-hook-events.jsonl'))
    for (const [i, parsed] of [codex, cursor, claude].entries()) {
      if (!parsed.ok) throw new Error('parse')
      expect(ledger.append(`k${i}`, parsed.envelope)).toBe(true)
    }
    const rows = readFileSync(ledger.path, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rows.map(r => r.provider)).toEqual(['codex', 'cursor', 'claude'])
    // The projection drops cursor_version, which is why the row must carry the provider.
    expect(rows[1].payload).not.toHaveProperty('cursor_version')
    // The Codex turn id and model are kept (plan 2.1).
    expect(rows[0].payload).toMatchObject({ turn_id: 't-1', model: 'gpt-6.1-sol' })

    const replayed: HookEnvelope[] = []
    ledger.replay(0, env => { replayed.push(env) })
    expect(replayed.map(e => e.provider)).toEqual(['codex', 'cursor', 'claude'])
    const store = new SessionSignalStore(noSpawn)
    for (const env of replayed) store.apply(env)
    expect(store.get(CODEX)?.provider).toBe('codex')
    expect(store.get(CURSOR)?.provider).toBe('cursor')
    expect(store.get(CLAUDE)?.provider).toBe('claude')
  })

  it('an older row with no provider replays exactly as before (no provider on the record)', () => {
    const ledger = new SessionHookLedger(join(dataDir(), 'session-hook-events.jsonl'))
    const env: HookEnvelope = { ts: 1_790_000_000_000, ppid: 7, event: 'UserPromptSubmit', sessionId: CLAUDE, payload: { session_id: CLAUDE, prompt: 'x' } }
    expect(ledger.append('old', env)).toBe(true)
    const row = JSON.parse(readFileSync(ledger.path, 'utf8').trim())
    expect(row).not.toHaveProperty('provider')
    const replayed: HookEnvelope[] = []
    ledger.replay(0, e => { replayed.push(e) })
    expect(replayed[0]).not.toHaveProperty('provider')
    expect(applyHookEvent(undefined, replayed[0], noSpawn)).not.toHaveProperty('provider')
  })
})

describe('Interrupt closes a turn (Codex Esc)', () => {
  it('an open Codex turn reads idle after its Interrupt, with no reply and no failure', () => {
    const at = (ts: number, event: HookEnvelope['event'], payload: Record<string, unknown> = {}): HookEnvelope =>
      ({ ts, ppid: 9, event, sessionId: CODEX, provider: 'codex', payload: { session_id: CODEX, turn_id: 't', ...payload } })
    let s: SessionSignal | undefined
    s = applyHookEvent(s, at(1_000, 'UserPromptSubmit', { prompt: 'go' }), noSpawn)
    s = applyHookEvent(s, at(2_000, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), noSpawn)
    expect(s.turnOpen).toBe(true)
    s = applyHookEvent(s, at(3_000, 'Interrupt'), noSpawn)
    expect(s).toMatchObject({ turnOpen: false, stopAt: 3_000, waiting: null, failure: null, lastReply: '', lastEvent: 'Interrupt' })
    expect(deriveSessionState({ signal: s, registry: undefined, transcript: undefined, now: 4_000 }).agent_state).toBe('idle')
    // The ledger keeps an Interrupt as a bare projection; parse accepts it (6.61.7 rejected it as unknown_event).
    expect(projectHookPayload('Interrupt', { session_id: CODEX, cwd: '/x', turn_id: 't', model: 'm', permission_mode: 'bypassPermissions' }))
      .toEqual({ session_id: CODEX, cwd: '/x', permission_mode: 'bypassPermissions', turn_id: 't', model: 'm' })
    expect(parseHookEnvelope(line({ ts: 1, ppid: 1, event: 'Interrupt', payload: { session_id: CODEX } })).ok).toBe(true)
  })
})

describe('a prompt after SessionEnd revives a Codex or Cursor record, never a Claude one (plan 1.5)', () => {
  for (const provider of ['codex', 'cursor', 'claude'] as const) {
    it(provider, () => {
      const id = provider === 'claude' ? CLAUDE : provider === 'codex' ? CODEX : CURSOR
      const at = (ts: number, event: HookEnvelope['event'], payload: Record<string, unknown> = {}): HookEnvelope =>
        ({ ts, ppid: 9, event, sessionId: id, provider, payload: { session_id: id, ...payload } })
      let s = applyHookEvent(undefined, at(1_000, 'SessionEnd', { reason: 'other' }), noSpawn)
      expect(s.ended).not.toBeNull()
      s = applyHookEvent(s, at(2_000, 'UserPromptSubmit', { prompt: 'again' }), noSpawn)
      const derived = deriveSessionState({ signal: s, registry: undefined, transcript: undefined, now: 2_500 })
      if (provider === 'claude') {
        expect(s.ended).not.toBeNull()
        expect(derived.agent_state).toBe('ended')
      } else {
        expect(s.ended).toBeNull()
        expect(derived.agent_state).toBe('running')
      }
    })
  }
})

describe('AgentThought: memory and live feed only (plan 1.7, W18)', () => {
  const thought = (ts: number, text: unknown, extra: Record<string, unknown> = {}): HookEnvelope =>
    ({ ts, ppid: null, event: 'AgentThought', sessionId: CURSOR, provider: 'cursor', payload: { session_id: CURSOR, display_only: true, text, ...extra } })

  it('keeps the newest thought capped at 280, tells only the thought listeners, and never opens a turn', () => {
    const store = new SessionSignalStore(noSpawn)
    const signals: string[] = []
    const thoughts: string[] = []
    store.subscribe((_s, env) => { signals.push(env.event) })
    store.subscribeThoughts((_s, t) => { thoughts.push(t.text) })
    store.apply(thought(1_000, 'Reading the queue code first.'))
    const long = 'x'.repeat(1_000)
    const after = store.apply(thought(2_000, long))
    expect(after.lastThought?.text.length).toBe(AGENT_THOUGHT_MAX)
    expect(after.lastThought?.at).toBe(2_000)
    expect(after.observationOnly).toBe(true)
    expect(after.turnOpen).toBe(false)
    // A late, older thought never replaces a newer one, and is not announced.
    expect(store.apply(thought(1_500, 'stale')).lastThought?.at).toBe(2_000)
    expect(thoughts).toEqual(['Reading the queue code first.', `${'x'.repeat(AGENT_THOUGHT_MAX - 1)}…`])
    expect(signals).toEqual([])
    // Even without `display_only`, a thought is never a phase event.
    const bare = store.apply({ ...thought(3_000, 'no flag'), payload: { session_id: CURSOR, text: 'no flag' } })
    expect(bare.turnOpen).toBe(false)
    expect(signals).toEqual([])
  })

  it('the projection, and so the ledger and every replay, keeps no thought text', () => {
    const projected = projectHookPayload('AgentThought', { session_id: CURSOR, display_only: true, text: 'secret: sk-live-123', model: 'grok-4.7' })
    expect(JSON.stringify(projected)).not.toContain('secret')
    expect(projected).not.toHaveProperty('text')
    const ledger = new SessionHookLedger(join(dataDir(), 'session-hook-events.jsonl'))
    expect(ledger.append('t1', thought(1_000, 'secret: sk-live-123'))).toBe(true)
    expect(readFileSync(ledger.path, 'utf8')).not.toContain('secret')
    const store = new SessionSignalStore(noSpawn)
    ledger.replay(0, env => { store.apply(env) })
    expect(store.get(CURSOR)?.lastThought).toBeUndefined()
  })
})
