// The SSE route with the 6.48.1 additions, executed end to end over a real socket:
// the derived state rides every status draft, a hook signal change becomes a live
// status draft, `COS_SESSION_HOOK_SSE=0` keeps 6.48.0's status fields, `?after=` replays
// from the ring within one server life, `?seed=turn` seeds the whole current turn, a
// frame carries `id: <epoch>.<cursor>`, an attached COS turn outranks the hooks, and
// the registry vetoes a hook state the way the rows' derive does (QA round, 2026-09-15).
//
// The 6.9.478 parser is REPLICATED here by its documented behaviour (canary 8): unknown
// fields stripped, `seq` kept, unknown kinds dropped before seq accounting. Zero gap
// rows is the property that lets an old lens read the new frames.

import express from 'express'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionStreamRouter, cursorReplayable, parseAfterCursor } from './agent-session-stream.js'
import { __resetSessionStreamBusForTests, beginAttachedTurn, publishSessionStream, RING_EPOCH, sessionStreamKey } from '../lib/session-stream-bus.js'
import { __resetSessionHooksForTests, sessionSignalStore } from '../lib/session-hooks-runtime.js'
import type { HookEnvelope } from '../lib/session-hook-events.js'

const SID = 'a1b2c3d4-0000-4000-8000-00000000c0de'
// Real clocks: the deriver expires a hook-derived wait older than its ceiling.
const T0 = Date.now() - 60_000
const env = (ts: number, event: HookEnvelope['event'], payload: Record<string, unknown> = {}): HookEnvelope =>
  ({ ts, ppid: 4242, event, sessionId: SID, payload: { session_id: SID, ...payload } })
const j = (o: unknown) => JSON.stringify(o)
const user = (text: string) => j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const tool = (cmd: string) => j({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_' + cmd, name: 'Bash', input: { command: cmd } }] } })
const endTurn = (text: string) => j({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
const result = (cmd: string, stdout: string) => j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + cmd, content: stdout }] }, toolUseResult: { stdout, stderr: '', interrupted: false } })

/** What the shipped 6.9.478 lens does with a frame: keep seq, drop unknown kinds, strip extras. */
function shippedParse(data: string): { seq: number; kind: string; state?: string } | null {
  const o = JSON.parse(data) as Record<string, unknown>
  if (!['tool', 'prompt', 'prose', 'status', 'heartbeat'].includes(String(o.kind))) return null
  return { seq: Number(o.seq), kind: String(o.kind), ...(o.kind === 'status' ? { state: String(o.state) } : {}) }
}

interface Frame { id: string | null; data: Record<string, unknown> }

async function readFrames(url: string, count: number, timeoutMs = 4_000, headers: Record<string, string> = {}): Promise<Frame[]> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal, headers })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Frame[] = []
  const deadline = Date.now() + timeoutMs
  while (frames.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>(r => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))])
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      let id: string | null = null
      let data: string | null = null
      for (const line of part.split('\n')) {
        if (line.startsWith('id: ')) id = line.slice(4)
        if (line.startsWith('data: ')) data = line.slice(6)
      }
      if (data !== null) frames.push({ id, data: JSON.parse(data) })
    }
  }
  controller.abort()
  return frames
}

describe('GET /api/agent-sessions/claude/:id/stream (6.48.1)', () => {
  const saved: Record<string, string | undefined> = {}
  const KEYS = ['COS_AGENT_SESSIONS_HOME', 'COS_CLAUDE_SESSIONS_ENABLED', 'COS_SESSION_HOOKS', 'COS_SESSION_HOOK_SSE', 'COS_SESSION_STREAM_ENABLED', 'COS_CLAUDE_SESSIONS_DIR'] as const
  const closers: Array<() => Promise<void>> = []
  let home: string
  let transcript: string

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
    home = mkdtempSync(join(tmpdir(), 'cos-stream-'))
    const dir = join(home, '.claude', 'projects', '-Users-example-project')
    mkdirSync(dir, { recursive: true })
    transcript = join(dir, `${SID}.jsonl`)
    // `ls` has its result in the transcript; `pwd` and `whoami` are still running.
    writeFileSync(transcript, [user('first question'), tool('ls'), result('ls', 'a\nb\nc'), endTurn('done one'), user('second question'), tool('pwd'), tool('whoami')].join('\n') + '\n')
    process.env.COS_AGENT_SESSIONS_HOME = home
    // An isolated, empty registry: the stream's derive reads the SAME registry the rows do.
    mkdirSync(join(home, 'sessions'), { recursive: true })
    process.env.COS_CLAUDE_SESSIONS_DIR = join(home, 'sessions')
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    process.env.COS_SESSION_HOOKS = '1'
    delete process.env.COS_SESSION_HOOK_SSE
    delete process.env.COS_SESSION_STREAM_ENABLED
    __resetSessionHooksForTests()
    __resetSessionStreamBusForTests()
  })

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    __resetSessionHooksForTests()
    __resetSessionStreamBusForTests()
  })

  async function start(): Promise<string> {
    const app = express()
    app.use('/api', agentSessionStreamRouter)
    const server = await new Promise<ReturnType<typeof app.listen>>(r => { const l = app.listen(0, '127.0.0.1', () => r(l)) })
    closers.push(() => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-sessions/claude/${SID}/stream`
  }

  it('stamps the derived state on the opening status, seeds the newest prompt, and the shipped parser sees no gap', async () => {
    sessionSignalStore.apply(env(T0 + 1_000, 'SessionStart', { source: 'startup' }))
    sessionSignalStore.apply(env(T0 + 2_000, 'UserPromptSubmit', { prompt: 'second question' }))
    sessionSignalStore.apply(env(T0 + 3_000, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'whoami' } }))
    const frames = await readFrames(await start(), 6)
    expect(frames[0].data).toMatchObject({ seq: 1, kind: 'status', state: 'working', agent_state: 'waiting', state_source: 'hook', waiting_kind: 'permission', waiting_detail: 'Bash whoami', state_since: new Date(T0 + 3_000).toISOString() })
    expect(frames[0].id).toBeNull() // the opening status is not a ring event
    expect(frames[1].data).toMatchObject({ seq: 2, kind: 'prompt', text: 'second question' })
    // The default seed is the last SEED_EVENTS steps whatever the turn (what shipped lenses expect).
    expect(frames.slice(2).map(f => f.data.kind)).toEqual(['tool', 'prose', 'tool', 'tool'])
    // 6.49.1: a seeded step whose result is already in the transcript carries it, with
    // the call id; the two still running carry neither. The outcome status draft
    // itself is NOT seeded (it would read as a stale state).
    expect(frames[2].data).toMatchObject({ kind: 'tool', target: 'ls', call: 'toolu_ls', outcome: { ok: true, detail: '3 lines' } })
    expect(frames[4].data).toMatchObject({ kind: 'tool', target: 'pwd', call: 'toolu_pwd' })
    expect(frames[4].data).not.toHaveProperty('outcome')
    expect(frames.some(f => f.data.kind === 'status' && 'tool_outcome' in f.data)).toBe(false)
    const parsed = frames.map(f => shippedParse(JSON.stringify(f.data)))
    expect(parsed.every(p => p !== null)).toBe(true)
    expect(parsed.map(p => p!.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(parsed[0]).toEqual({ seq: 1, kind: 'status', state: 'working' })
  })

  it('a hook signal change is a live status draft, and only a CHANGE is', async () => {
    sessionSignalStore.apply(env(T0 + 1_000, 'SessionStart', { source: 'startup' }))
    sessionSignalStore.apply(env(T0 + 2_000, 'UserPromptSubmit', { prompt: 'second question' }))
    const url = await start()
    const framesPromise = readFrames(url, 8) // 6 seeded + 2 live state changes
    await new Promise(r => setTimeout(r, 150))
    sessionSignalStore.apply(env(T0 + 4_000, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }))   // running -> running: no line
    sessionSignalStore.apply(env(T0 + 5_000, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'whoami' } }))
    sessionSignalStore.apply(env(T0 + 6_000, 'Stop', { last_assistant_message: 'done two' }))
    const frames = await framesPromise
    const statuses = frames.filter(f => f.data.kind === 'status').map(f => ({ agent_state: f.data.agent_state, state: f.data.state, waiting_kind: f.data.waiting_kind, last: f.data.last_reply }))
    expect(statuses).toEqual([
      { agent_state: 'running', state: 'working', waiting_kind: undefined, last: undefined },
      { agent_state: 'waiting', state: 'working', waiting_kind: 'permission', last: undefined },
      // `last_reply` rides an idle state only: the feed's "Idle, last reply: …" line.
      { agent_state: 'idle', state: 'idle', waiting_kind: undefined, last: 'done two' },
    ])
  })

  it('an ATTACHED COS turn outranks the hooks on the wire: working while the child writes, the engine state again once it ends', async () => {
    // QA blocker B1 (2026-09-15): a Continue child shares the tab's session id; the tab's
    // older Stop read the wire `idle`, and the child's own SessionEnd erased its trail as
    // `done`. The deriver is told the turn is attached and answers running until it is not.
    sessionSignalStore.apply(env(T0 + 1_000, 'SessionStart', { source: 'startup' }))
    sessionSignalStore.apply(env(T0 + 2_000, 'UserPromptSubmit', { prompt: 'second question' }))
    sessionSignalStore.apply(env(T0 + 3_000, 'Stop', { last_assistant_message: 'done two' }))
    const key = sessionStreamKey('claude', SID)
    const end = beginAttachedTurn(key)
    const url = await start()
    const framesPromise = readFrames(url, 7) // 6 seeded + the one state change after the detach
    await new Promise(r => setTimeout(r, 150))
    // The child's SessionEnd lands while the turn is attached: no `done`, no line at all.
    sessionSignalStore.apply(env(T0 + 4_000, 'SessionEnd', { reason: 'other' }), true)
    await new Promise(r => setTimeout(r, 100))
    end()
    // Detaching fires no hook; the next signals re-derive without the attached override:
    // a new prompt is running again (same wire state, no line), its Stop is idle (a line).
    sessionSignalStore.apply(env(T0 + 5_000, 'UserPromptSubmit', { prompt: 'third question' }))
    sessionSignalStore.apply(env(T0 + 6_000, 'Stop', { last_assistant_message: 'done three' }))
    const frames = await framesPromise
    const statuses = frames.filter(f => f.data.kind === 'status').map(f => [f.data.state, f.data.agent_state, f.data.state_source])
    expect(statuses).toEqual([['working', 'running', 'transcript'], ['idle', 'idle', 'hook']])
    expect(frames.some(f => f.data.state === 'done')).toBe(false)
  })

  it('the registry vetoes a hook state exactly as the rows do: an Esc-interrupted turn (registry idle after the last hook) reads idle, not running', async () => {
    // QA W6: the stream used to derive with no registry facts, so the lens header said
    // Working for up to 30 min while the list row said idle.
    sessionSignalStore.apply(env(T0 + 1_000, 'SessionStart', { source: 'startup' }))
    sessionSignalStore.apply(env(T0 + 2_000, 'UserPromptSubmit', { prompt: 'second question' }))
    writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: SID, entrypoint: 'claude-desktop', kind: 'desktop', cwd: '/tmp',
      status: 'idle', statusUpdatedAt: T0 + 2_500, lastActiveAt: T0 + 2_500, startedAt: T0,
    }))
    const frames = await readFrames(await start(), 1)
    expect(frames[0].data).toMatchObject({ kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'registry' })
  })

  it('COS_SESSION_HOOK_SSE=0 writes 6.48.0 frames: no extra fields, no live state drafts', async () => {
    process.env.COS_SESSION_HOOK_SSE = '0'
    sessionSignalStore.apply(env(T0 + 1_000, 'SessionStart', { source: 'startup' }))
    sessionSignalStore.apply(env(T0 + 3_000, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'whoami' } }))
    const url = await start()
    const framesPromise = readFrames(url, 7, 1_500) // 6 seeded; a 7th would be a live status draft
    await new Promise(r => setTimeout(r, 100))
    sessionSignalStore.apply(env(T0 + 6_000, 'Stop', { last_assistant_message: 'done' }))
    const frames = await framesPromise
    expect(frames).toHaveLength(6)
    expect(frames[0].data).not.toHaveProperty('agent_state')
    expect(frames.filter(f => f.data.kind === 'status')).toHaveLength(1)
  })

  it('?seed=turn seeds the whole current turn oldest first; the default seeds the last steps', async () => {
    const url = await start()
    const turn = await readFrames(`${url}?seed=turn`, 4)
    expect(turn.map(f => f.data.kind)).toEqual(['status', 'prompt', 'tool', 'tool'])
    expect(turn.slice(2).map(f => f.data.target)).toEqual(['pwd', 'whoami'])
  })

  it('?after=<cursor> replays the ring instead of seeding, and frames carry id: with the cursor', async () => {
    const key = sessionStreamKey('claude', SID)
    const url = await start()
    // A first client is connected while three events are published.
    const first = readFrames(url, 9) // 6 seeded + 3 live
    await new Promise(r => setTimeout(r, 100))
    publishSessionStream(key, { kind: 'tool', verb: 'bash', target: 'one', detail: '' })
    publishSessionStream(key, { kind: 'tool', verb: 'bash', target: 'two', detail: '' })
    publishSessionStream(key, { kind: 'tool', verb: 'bash', target: 'three', detail: '' })
    const frames = await first
    const live = frames.filter(f => f.id !== null)
    const E = RING_EPOCH
    expect(live.map(f => [f.id, f.data.cursor, f.data.epoch, f.data.target])).toEqual([[`${E}.1`, 1, E, 'one'], [`${E}.2`, 2, E, 'two'], [`${E}.3`, 3, E, 'three']])
    // A reconnect after cursor 1 (the id: line's form) gets two and three, and no seed.
    const again = await readFrames(`${url}?after=${E}.1`, 3)
    expect(again.map(f => [f.data.kind, f.data.target ?? f.data.state])).toEqual([['status', 'working'], ['tool', 'two'], ['tool', 'three']])
    // The standard SSE header is the fallback for the query.
    const header = await readFrames(url, 3, 4_000, { 'last-event-id': `${E}.1` })
    expect(header.map(f => [f.data.kind, f.data.target ?? f.data.state])).toEqual([['status', 'working'], ['tool', 'two'], ['tool', 'three']])
    // A cursor past the ring (a restarted server's fresh ring) falls back to the seed.
    const stale = await readFrames(`${url}?after=${E}.9`, 2)
    expect(stale[1].data.kind).toBe('prompt')
    // A cursor from another server life falls back to the seed, whatever its number.
    const other = await readFrames(`${url}?after=${E - 1}.1`, 2)
    expect(other[1].data.kind).toBe('prompt')
    // A cursor AT the newest event has nothing to replay: that is a seed, never an
    // opening status and an empty screen (QA W3: the sole client's own gap is not in the ring).
    const caughtUp = await readFrames(`${url}?after=${E}.3`, 2)
    expect(caughtUp[1].data.kind).toBe('prompt')
  })

  it('cursorReplayable: only a cursor whose successor the ring still holds, and that has one', () => {
    const bounds = { oldest: 3, newest: 7 }
    expect(cursorReplayable(2, bounds)).toBe(true)     // the event after it (3) is the oldest kept
    expect(cursorReplayable(6, bounds)).toBe(true)
    expect(cursorReplayable(1, bounds)).toBe(false)    // evicted: a replay would hide the gap
    expect(cursorReplayable(7, bounds)).toBe(false)    // at the newest: nothing to replay, so seed
    expect(cursorReplayable(9, bounds)).toBe(false)
    expect(cursorReplayable(null, bounds)).toBe(false)
    expect(cursorReplayable(2, null)).toBe(false)
  })

  it('parseAfterCursor: the id: form from this epoch, a bare cursor, and nothing else', () => {
    expect(parseAfterCursor(`${RING_EPOCH}.7`)).toBe(7)
    expect(parseAfterCursor('7')).toBe(7)
    expect(parseAfterCursor(`${RING_EPOCH - 1}.7`)).toBeNull()
    for (const bad of ['', ' ', 'x', '-1', '1.5.2', `${RING_EPOCH}.`, `${RING_EPOCH}.-1`, undefined, 3]) expect(parseAfterCursor(bad)).toBeNull()
  })
})
