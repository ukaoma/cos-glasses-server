import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOOK_EVENT_NAMES, parseHookEnvelope, toolFingerprint, type HookEnvelope } from './session-hook-events.js'
import { applyHookEvent, SessionSignalStore, SIGNAL_PRUNE_AFTER_END_MS, type SessionSignal } from './session-signal-store.js'
import { DEAD_GRACE_MS, HOOK_SILENCE_MS, OPEN_TURN_CEILING_MS, deriveSessionState } from './session-state-derive.js'
import { HOOK_SUBSCRIPTIONS } from './claude-hooks-installer.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'session-hooks-6.48.0')
const noSpawn = { isCosSpawnedPid: () => false }

function recording(name: string): HookEnvelope[] {
  return readFileSync(join(FIXTURES, name), 'utf-8').split('\n').filter(Boolean).map(line => {
    const parsed = parseHookEnvelope(line)
    if (!parsed.ok) throw new Error(`${name}: ${parsed.reason}`)
    return parsed.envelope
  })
}

function replay(name: string, ctx = noSpawn): SessionSignal[] {
  let signal: SessionSignal | undefined
  const states: SessionSignal[] = []
  for (const env of recording(name)) {
    signal = applyHookEvent(signal, env, ctx)
    states.push(signal)
  }
  return states
}

describe('recorded 2.1.272 sequences replay into the expected phases', () => {
  it('a print-mode run: idle, running, idle, ended', () => {
    const states = replay('p-mode-run.hooks.jsonl')
    expect(states.map(s => s.lastEvent)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'])
    expect(states[0].turnOpen).toBe(false)
    expect(states[1].turnOpen).toBe(true)
    expect(states[1].promptId).toMatch(/^[0-9a-f-]{36}$/)
    expect(states[2].turnOpen).toBe(false)
    expect(states[2].lastReply).toBe('canary')
    expect(states[2].stopAt).toBe(states[2].lastEventAt)
    expect(states[3].ended?.reason).toBe('other')
    expect(states[3].cwd).toBe('/Users/example/project')
    expect(states[3].transcriptPath).toContain('.jsonl')
  })

  it('a permission prompt reads waiting/permission with the tool and its target, and clears on its own PostToolUse', () => {
    const states = replay('post-tool-use.hooks.jsonl')
    const events = states.map(s => s.lastEvent)
    expect(events).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])
    const first = states[2]
    expect(first.waiting).toMatchObject({ kind: 'permission', toolName: 'Bash', detail: 'Bash touch par-a' })
    expect(first.waiting?.fingerprint).toBe(toolFingerprint('Bash', recording('post-tool-use.hooks.jsonl')[2].payload.tool_input))
    // The matching PostToolUse resolves it; the record now names the tool that ran.
    expect(states[3].waiting).toBeNull()
    expect(states[3].lastTool).toBe('Bash')
    // The second prompt is its own waiting entry, resolved by its own PostToolUse.
    expect(states[4].waiting?.detail).toBe('Bash touch par-b')
    expect(states[5].waiting).toBeNull()
    expect(states[6].lastTool).toBe('Read')
    expect(states[7].turnOpen).toBe(false)
    expect(states[7].lastReply).toBe('done')
  })

  it('a PostToolUse for a DIFFERENT tool does not clear a pending permission', () => {
    const rec = recording('post-tool-use.hooks.jsonl')
    const permission = rec[2]
    const otherTool = { ...rec[3], payload: { ...rec[3].payload, tool_name: 'Read', tool_input: { file_path: '/elsewhere' } } }
    let s = applyHookEvent(undefined, rec[0], noSpawn)
    s = applyHookEvent(s, rec[1], noSpawn)
    s = applyHookEvent(s, permission, noSpawn)
    s = applyHookEvent(s, otherTool, noSpawn)
    expect(s.waiting?.kind).toBe('permission')
    expect(s.lastTool).toBe('Read')
  })

  it('a hook deny with a message: no PermissionDenied follows, Stop clears the wait and carries the reason', () => {
    const states = replay('permission-deny.hooks.jsonl')
    expect(states.map(s => s.lastEvent)).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'])
    expect(states[2].waiting?.kind).toBe('permission')
    expect(states[3].waiting).toBeNull()
    expect(states[3].lastReply).toBe('Denied from COS canary')
  })

  it('no decision in print mode: the tool is blocked by Claude and the turn still stops cleanly', () => {
    const states = replay('permission-no-decision.hooks.jsonl')
    expect(states.at(-2)?.turnOpen).toBe(false)
    expect(states.at(-2)?.lastReply).toMatch(/blocked/i)
    expect(states.at(-1)?.ended).not.toBeNull()
  })

  it('every event the reducer handles is either recorded here or listed as interactive-only', () => {
    const recorded = new Set<string>()
    for (const file of readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl'))) {
      for (const env of recording(file)) recorded.add(env.event)
    }
    const interactiveOnly = new Set(['StopFailure', 'PermissionDenied', 'PreToolUse', 'Notification', 'SubagentStart', 'SubagentStop', 'PostCompact', 'PostModelSwitch'])
    for (const name of HOOK_EVENT_NAMES) {
      expect(recorded.has(name) || interactiveOnly.has(name), name).toBe(true)
    }
    // And the interactive-only list shrinks as recordings arrive: a recorded event must not stay on it.
    for (const name of interactiveOnly) expect(recorded.has(name), `${name} is recorded; drop it from interactiveOnly`).toBe(false)
  })

  it('the installer subscribes exactly the events the reducer understands (one list, two homes, pinned)', () => {
    expect([...HOOK_SUBSCRIPTIONS.map(s => s.event)].sort()).toEqual([...HOOK_EVENT_NAMES].sort())
    expect(new Set(HOOK_SUBSCRIPTIONS.map(s => s.event)).size).toBe(HOOK_SUBSCRIPTIONS.length)
  })
})

describe('the reducer rules the validation rounds added', () => {
  const base = recording('p-mode-run.hooks.jsonl')
  const at = (ts: number, event: HookEnvelope['event'], payload: Record<string, unknown>, ppid: number | null = 4242): HookEnvelope =>
    ({ ts, ppid, event, sessionId: base[0].sessionId, payload: { session_id: base[0].sessionId, ...payload } })

  it('a COS-spawned child on the same session id is counted, never applied', () => {
    const ctx = { isCosSpawnedPid: (pid: number | null) => pid === 9999 }
    let s = applyHookEvent(undefined, base[0], ctx)
    s = applyHookEvent(s, base[1], ctx) // the tab's own prompt: running
    s = applyHookEvent(s, at(base[1].ts + 1000, 'SessionEnd', { reason: 'other' }, 9999), ctx)
    expect(s.turnOpen).toBe(true)
    expect(s.ended).toBeNull()
    expect(s.childEvents).toBe(1)
  })

  it('SessionStart(compact) keeps the open turn; SessionStart(resume) after an end clears ended', () => {
    let s = applyHookEvent(undefined, base[0], noSpawn)
    s = applyHookEvent(s, base[1], noSpawn)
    s = applyHookEvent(s, at(base[1].ts + 10, 'SessionStart', { source: 'compact' }), noSpawn)
    expect(s.turnOpen).toBe(true)
    expect(s.compactions).toBe(1)
    s = applyHookEvent(s, at(base[1].ts + 20, 'SessionEnd', { reason: 'other' }), noSpawn)
    expect(s.ended).not.toBeNull()
    s = applyHookEvent(s, at(base[1].ts + 30, 'SessionStart', { source: 'resume' }), noSpawn)
    expect(s.ended).toBeNull()
    expect(s.turnOpen).toBe(false)
  })

  it('AskUserQuestion and ExitPlanMode read waiting by tool name and clear on their own PostToolUse', () => {
    let s = applyHookEvent(undefined, base[1], noSpawn)
    s = applyHookEvent(s, at(base[1].ts + 5, 'PreToolUse', { tool_name: 'ExitPlanMode', tool_input: {} }), noSpawn)
    expect(s.waiting?.kind).toBe('plan')
    s = applyHookEvent(s, at(base[1].ts + 6, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), noSpawn)
    expect(s.waiting?.kind).toBe('plan')
    s = applyHookEvent(s, at(base[1].ts + 7, 'PostToolUse', { tool_name: 'ExitPlanMode', tool_input: {} }), noSpawn)
    expect(s.waiting).toBeNull()
    s = applyHookEvent(s, at(base[1].ts + 8, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }), noSpawn)
    expect(s.waiting?.kind).toBe('question')
  })

  it('Notification never downgrades an existing wait, idle_prompt closes the turn, StopFailure reads failed', () => {
    let s = applyHookEvent(undefined, base[1], noSpawn)
    s = applyHookEvent(s, at(base[1].ts + 5, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } }), noSpawn)
    s = applyHookEvent(s, at(base[1].ts + 6, 'Notification', { notification_type: 'agent_needs_input', message: 'x' }), noSpawn)
    expect(s.waiting?.kind).toBe('permission')
    // A parallel auto-allowed Bash ending does not clear the prompt; a denial of the same tool does.
    s = applyHookEvent(s, at(base[1].ts + 6, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), noSpawn)
    expect(s.waiting?.kind).toBe('permission')
    s = applyHookEvent(s, at(base[1].ts + 7, 'PermissionDenied', { tool_name: 'Read', tool_input: { file_path: '/x' } }), noSpawn)
    expect(s.waiting?.kind).toBe('permission')
    s = applyHookEvent(s, at(base[1].ts + 7, 'PermissionDenied', { tool_name: 'Bash' }), noSpawn)
    expect(s.waiting).toBeNull()
    s = applyHookEvent(s, at(base[1].ts + 8, 'Notification', { notification_type: 'idle_prompt', message: '' }), noSpawn)
    expect(s.turnOpen).toBe(false)
    s = applyHookEvent(s, at(base[1].ts + 9, 'UserPromptSubmit', { prompt: 'again' }), noSpawn)
    s = applyHookEvent(s, at(base[1].ts + 10, 'StopFailure', { matcher: 'rate_limit' }), noSpawn)
    expect(s.failure?.kind).toBe('rate_limit')
    expect(s.turnOpen).toBe(false)
  })

  it('6.48.1: a main-thread tool event opens the turn a mid-turn adoption never saw start; a sub-agent tool does not; nothing reopens after SessionEnd', () => {
    // A tab that was mid-turn when the hooks were installed sends PostToolUse with no
    // UserPromptSubmit before it (measured 2026-09-15 16:16 on this session).
    let s = applyHookEvent(undefined, at(base[0].ts + 1, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), noSpawn)
    expect(s.turnOpen).toBe(true)
    expect(s.turnStartedAt).toBe(base[0].ts + 1)
    s = applyHookEvent(s, at(base[0].ts + 2, 'Stop', { last_assistant_message: 'ok' }), noSpawn)
    expect(s.turnOpen).toBe(false)
    // A sub-agent's tool event carries agent_id and says nothing about the main thread.
    s = applyHookEvent(s, at(base[0].ts + 3, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, agent_id: 'agent-1' }), noSpawn)
    expect(s.turnOpen).toBe(false)
    // PreToolUse of a plain tool opens it too; ended sessions never reopen.
    s = applyHookEvent(s, at(base[0].ts + 4, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }), noSpawn)
    expect(s.turnOpen).toBe(true)
    s = applyHookEvent(s, at(base[0].ts + 5, 'SessionEnd', { reason: 'other' }), noSpawn)
    s = applyHookEvent(s, at(base[0].ts + 6, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), noSpawn)
    expect(s.turnOpen).toBe(false)
    // The turn's start is kept once known: a later tool event does not move it.
    let t = applyHookEvent(undefined, base[1], noSpawn)
    t = applyHookEvent(t, at(base[1].ts + 10, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), noSpawn)
    expect(t.turnStartedAt).toBe(base[1].ts)
  })

  it('6.48.1: the store records an entrypoint once, for a known session only', () => {
    const store = new SessionSignalStore(noSpawn)
    store.setEntrypoint('a1b2c3d4-0000-4000-8000-000000000001', 'sdk-cli')
    expect(store.size()).toBe(0)
    store.apply(base[0])
    expect(store.get(base[0].sessionId)?.entrypoint).toBeNull()
    store.setEntrypoint(base[0].sessionId, 'sdk-cli')
    expect(store.get(base[0].sessionId)?.entrypoint).toBe('sdk-cli')
    store.setEntrypoint(base[0].sessionId, null)
    expect(store.get(base[0].sessionId)?.entrypoint).toBe('sdk-cli')
  })

  it('the keep-warm readiness prompt is flagged from the recorded prompt prefix', () => {
    const s = applyHookEvent(undefined, at(1, 'UserPromptSubmit', { prompt: 'This is an automated local readiness check. Reply ready.' }), noSpawn)
    expect(s.keepWarm).toBe(true)
  })
})

describe('the store', () => {
  it('finds a session by its eight-character prefix and refuses an ambiguous one', () => {
    const store = new SessionSignalStore(noSpawn)
    const rec = recording('p-mode-run.hooks.jsonl')
    store.apply(rec[0])
    expect(store.getByPrefix(rec[0].sessionId.slice(0, 8))?.sessionId).toBe(rec[0].sessionId)
    const twin = { ...rec[0], sessionId: rec[0].sessionId.slice(0, 8) + '-ffff-4fff-8fff-ffffffffffff', payload: { ...rec[0].payload, session_id: rec[0].sessionId.slice(0, 8) + '-ffff-4fff-8fff-ffffffffffff' } }
    store.apply(twin)
    expect(store.getByPrefix(rec[0].sessionId.slice(0, 8))).toBeUndefined()
    expect(store.get(rec[0].sessionId)).toBeDefined()
  })

  it('prunes ended records after the window and keeps open turns', () => {
    const store = new SessionSignalStore(noSpawn)
    const states = recording('p-mode-run.hooks.jsonl')
    for (const env of states) store.apply(env)
    expect(store.prune(states[3].ts + 1000)).toBe(0)
    expect(store.prune(states[3].ts + SIGNAL_PRUNE_AFTER_END_MS + 1)).toBe(1)
    expect(store.size()).toBe(0)
  })
})

describe('deriveSessionState ranks hook, registry and transcript', () => {
  const rec = recording('post-tool-use.hooks.jsonl')
  const signalAt = (n: number) => replay('post-tool-use.hooks.jsonl')[n]
  const now = rec.at(-1)!.ts + 1000

  it('hook wins with the waiting kind and detail while a prompt is pending', () => {
    const d = deriveSessionState({ signal: signalAt(2), registry: { alive: true, status: 'busy', waitingFor: null, statusUpdatedAt: rec[1].ts, lastActiveAt: rec[1].ts }, transcript: undefined, now: rec[2].ts + 500 })
    expect(d).toMatchObject({ agent_state: 'waiting', state_source: 'hook', waiting_kind: 'permission', waiting_detail: 'Bash touch par-a' })
    expect(d.state_since).toBe(new Date(rec[2].ts).toISOString())
  })

  it('a child SessionEnd with an alive registry record reads idle, not ended; with no record it reads ended', () => {
    const final = signalAt(8)
    const alive = deriveSessionState({ signal: final, registry: { alive: true, status: 'idle', waitingFor: null, statusUpdatedAt: rec[7].ts - 1, lastActiveAt: rec[7].ts }, transcript: undefined, now })
    expect(alive.agent_state).toBe('idle')
    expect(alive.last_reply).toBe('done')
    const gone = deriveSessionState({ signal: final, registry: undefined, transcript: undefined, now })
    expect(gone.agent_state).toBe('ended')
  })

  it('the registry decides only when the hooks have been silent AND its status moved later', () => {
    const stale = signalAt(1) // running, but from long ago
    const late = stale.lastEventAt + HOOK_SILENCE_MS + 15 * 60_000
    const d = deriveSessionState({ signal: stale, registry: { alive: true, status: 'idle', waitingFor: null, statusUpdatedAt: late - 60_000, lastActiveAt: late - 60_000 }, transcript: undefined, now: late })
    expect(d).toMatchObject({ agent_state: 'idle', state_source: 'registry' })
    // Silent, but the registry did NOT move after the last hook event: the hooks still speak.
    // (A pending prompt, since an open TURN past its ceiling yields on its own rule.)
    const pending = signalAt(2)
    const unmoved = deriveSessionState({ signal: pending, registry: { alive: true, status: 'busy', waitingFor: null, statusUpdatedAt: pending.lastEventAt - 1, lastActiveAt: pending.lastEventAt - 1 }, transcript: undefined, now: pending.lastEventAt + HOOK_SILENCE_MS + 60_000 })
    expect(unmoved).toMatchObject({ agent_state: 'waiting', state_source: 'hook' })
    // Moved later, but the hooks are NOT silent: the hook's detail stands over the registry's
    // bare `waiting` (which would read as a question with no detail).
    const moved = deriveSessionState({ signal: pending, registry: { alive: true, status: 'waiting', waitingFor: null, statusUpdatedAt: pending.lastEventAt + 200, lastActiveAt: pending.lastEventAt + 200 }, transcript: undefined, now: pending.lastEventAt + 5_000 })
    expect(moved).toMatchObject({ agent_state: 'waiting', state_source: 'hook', waiting_kind: 'permission', waiting_detail: 'Bash touch par-a' })
  })

  it('registry waiting maps a dialog to waiting/permission and anything else to a question; busy and idle map through', () => {
    // The registry on this Mac writes `waitingFor: "dialog open"` for a permission dialog (round 2).
    const w = deriveSessionState({ signal: undefined, registry: { alive: true, status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: 10, lastActiveAt: 10 }, transcript: undefined, now: 20 })
    expect(w).toMatchObject({ agent_state: 'waiting', state_source: 'registry', waiting_kind: 'permission', waiting_detail: 'dialog open' })
    const q = deriveSessionState({ signal: undefined, registry: { alive: true, status: 'waiting', waitingFor: 'input', statusUpdatedAt: 10, lastActiveAt: 10 }, transcript: undefined, now: 20 })
    expect(q).toMatchObject({ agent_state: 'waiting', waiting_kind: 'question', waiting_detail: 'input' })
    expect(deriveSessionState({ signal: undefined, registry: { alive: true, status: 'busy', waitingFor: null, statusUpdatedAt: 10, lastActiveAt: 10 }, transcript: undefined, now: 20 }).agent_state).toBe('running')
  })

  it('a dead pid needs two scans at least DEAD_GRACE_MS apart to end the row, and the transcript answers in between', () => {
    const registry = { alive: false, status: 'idle', waitingFor: null, statusUpdatedAt: 10, lastActiveAt: 10 }
    const transcript = { inFlight: false, lastActivityAt: 5 }
    const first = deriveSessionState({ signal: undefined, registry, transcript, now: 20 })
    expect(first).toMatchObject({ agent_state: 'idle', state_source: 'transcript', deadScans: 1, deadSince: 20 })
    // One client refresh is two requests milliseconds apart: the second scan alone is not a death.
    const soon = deriveSessionState({ signal: undefined, registry, transcript, now: 30, prevDeadScans: first.deadScans, prevDeadSince: first.deadSince })
    expect(soon).toMatchObject({ agent_state: 'idle', state_source: 'transcript', deadScans: 2, deadSince: 20 })
    const later = deriveSessionState({ signal: undefined, registry, transcript, now: 20 + DEAD_GRACE_MS, prevDeadScans: soon.deadScans, prevDeadSince: soon.deadSince })
    expect(later).toMatchObject({ agent_state: 'ended', state_source: 'registry', deadScans: 3 })
    // Alive again (a rewritten registry file) resets the memory.
    const back = deriveSessionState({ signal: undefined, registry: { ...registry, alive: true }, transcript, now: 20 + DEAD_GRACE_MS + 1, prevDeadScans: later.deadScans, prevDeadSince: later.deadSince })
    expect(back).toMatchObject({ agent_state: 'idle', state_source: 'registry', deadScans: 0, deadSince: null })
  })

  it('an open turn with no event for half an hour is no longer trusted as running', () => {
    const running = signalAt(1)
    const d = deriveSessionState({ signal: running, registry: undefined, transcript: { inFlight: false, lastActivityAt: running.lastEventAt }, now: running.lastEventAt + OPEN_TURN_CEILING_MS + 60_000 })
    expect(d).toMatchObject({ agent_state: 'idle', state_source: 'transcript' })
  })
})
