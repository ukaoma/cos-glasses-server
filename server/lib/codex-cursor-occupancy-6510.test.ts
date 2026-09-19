// 6.51.0 occupancy: the Codex turn clock and the Cursor composer turn signal.
//
// Both only ever NARROW or RENAME a refusal: a Codex holder the engine has finished with
// reads idle instead of working, and a Cursor composer its hooks show mid-turn reads
// working instead of unsupported. Neither can make a Claude verdict, an Agent CLI chat,
// or a thread with a doubt read differently.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { threadOccupancy, type OccupancyProbes } from './thread-occupancy.js'
import { withCodexTurnClock, withCursorComposerTurn } from './occupancy-probes.js'
import { readCodexTurnEndedAtMs } from './codex-turn-clock.js'
import { transcriptTurnVerdict } from './thread-turn-queue-store.js'

const CODEX = '01a00da5-8026-7bf3-a9cb-47e61f06ab29'
const CLAUDE = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const CURSOR = 'd1728e99-1007-4957-b36b-34df7d525e14'
const HOLDER = 85320
const dirs = { claudeSessionsDir: '/c/sessions', codexLocksDir: '/x/thread-writer-locks', cursorChatsDir: '/cur/chats' }

function base(over: Partial<OccupancyProbes> = {}): OccupancyProbes {
  return {
    isAlive: () => true,
    processStartMs: () => 1,
    fileExists: () => true,
    dirExists: () => true,
    readDir: () => [],
    readFile: () => null,
    lockHolders: () => [HOLDER],
    cosSpawnedPids: () => new Map(),
    cursorAgentSession: () => null,
    // Written this instant: without a clause the holder is WORKING.
    transcriptMtimeMs: () => Date.now(),
    ...over,
  }
}

describe('Codex turn clock in the gate', () => {
  it('a working Codex holder whose engine closed the turn reads idle: attachable, holder declared', () => {
    const probes = withCodexTurnClock(base(), () => Date.now())
    expect(threadOccupancy('codex', CODEX, probes, dirs)).toMatchObject({ attachable: true, reason: null, idleHolder: true })
  })
  it('without a closed turn the holder stays working', () => {
    const probes = withCodexTurnClock(base(), () => null)
    expect(threadOccupancy('codex', CODEX, probes, dirs)).toMatchObject({ attachable: false, reason: 'native_thread_working' })
  })
  it('a throwing or future-dated clock is not evidence', () => {
    expect(threadOccupancy('codex', CODEX, withCodexTurnClock(base(), () => { throw new Error('x') }), dirs).reason).toBe('native_thread_working')
    expect(threadOccupancy('codex', CODEX, withCodexTurnClock(base(), () => Date.now() + 10 * 60_000), dirs).reason).toBe('native_thread_working')
  })
  it('an unmeasurable transcript stays a doubt, whatever the clock says', () => {
    const probes = withCodexTurnClock(base({ transcriptMtimeMs: () => null }), () => Date.now())
    expect(threadOccupancy('codex', CODEX, probes, dirs)).toMatchObject({ attachable: false, reason: 'live_desktop_process' })
  })
  it('the Codex clock never answers for Claude, and keeps the inner Claude probe for Claude', () => {
    const asked: string[] = []
    const inner = base({ holderTurnEndedAtMs: (provider: string) => { asked.push(provider); return null } })
    const probes = withCodexTurnClock(inner, () => { asked.push('codex-reader'); return Date.now() })
    expect(probes.holderTurnEndedAtMs!('claude', CLAUDE)).toBeNull()
    expect(probes.holderTurnEndedAtMs!('codex', CODEX)).not.toBeNull()
    expect(probes.holderTurnEndedAtMs!('codex', '../x')).toBeNull()
    expect(asked).toEqual(['claude', 'codex-reader'])
  })
})

describe('readCodexTurnEndedAtMs against real rollout lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-codex-rollout-'))
  const rollout = (name: string, kinds: string[]) => {
    const path = join(dir, name)
    writeFileSync(path, kinds.map(k => JSON.stringify({ timestamp: '2026-09-19T13:24:10.422Z', type: 'event_msg', payload: { type: k } })).join('\n') + '\n')
    return path
  }
  const read = (path: string | null) => readCodexTurnEndedAtMs(CODEX, {} as never, { pathFor: () => path, verdict: transcriptTurnVerdict, mtimeMs: () => 1234 })

  it('answers the mtime when the newest marker is task_complete', () => {
    expect(read(rollout('done.jsonl', ['task_started', 'token_count', 'task_complete']))).toBe(1234)
  })
  it('a task_started after it (the app started its own queued turn) is open again', () => {
    expect(read(rollout('next.jsonl', ['task_started', 'task_complete', 'task_started']))).toBeNull()
  })
  it('an aborted turn is closed too (6.51.0, QA W1), and a new turn after it is open', () => {
    expect(read(rollout('aborted.jsonl', ['task_started', 'turn_aborted']))).toBe(1234)
    expect(read(rollout('aborted-then.jsonl', ['task_started', 'turn_aborted', 'task_started']))).toBeNull()
  })
  it('no marker, no file, or no path is null', () => {
    expect(read(rollout('none.jsonl', ['token_count', 'item_completed']))).toBeNull()
    expect(read(join(dir, 'missing.jsonl'))).toBeNull()
    expect(read(null)).toBeNull()
  })
})

describe('Cursor composer turn signal in the gate', () => {
  const signal = (over: Record<string, unknown> = {}) => ({ turnOpen: true, ended: null, lastEventAt: 10_000, ...over })
  const cursor = (s: ReturnType<typeof signal> | undefined, now = 20_000) =>
    withCursorComposerTurn(base(), () => s as never, () => now, 30 * 60_000)

  it('a composer the hooks show mid-turn is working, and still never attachable', () => {
    expect(threadOccupancy('cursor', CURSOR, cursor(signal()), dirs)).toEqual({ attachable: false, owners: [], reason: 'native_thread_working' })
  })
  it('closed, ended, stale, or unseen composers keep the 6.50 verdict', () => {
    for (const s of [signal({ turnOpen: false }), signal({ ended: { at: 1, reason: 'other' } }), undefined]) {
      expect(threadOccupancy('cursor', CURSOR, cursor(s), dirs).reason).toBe('unsupported_provider')
    }
    expect(threadOccupancy('cursor', CURSOR, cursor(signal(), 10_000 + 31 * 60_000), dirs).reason).toBe('unsupported_provider')
  })
  it('a throwing signal reader keeps the 6.50 verdict', () => {
    const probes = { ...base(), cursorComposerTurnOpen: () => { throw new Error('x') } }
    expect(threadOccupancy('cursor', CURSOR, probes, dirs).reason).toBe('unsupported_provider')
  })
  it('an Agent CLI chat is untouched: attachable exactly as before', () => {
    const probes = withCursorComposerTurn(
      base({ cursorAgentSession: () => ({ dir: '/cur/chats/h/x', cwd: '/w', hasConversation: true }) }),
      () => signal() as never, () => 20_000, 30 * 60_000)
    expect(threadOccupancy('cursor', CURSOR, probes, dirs)).toEqual({ attachable: true, owners: [], reason: null })
  })
  it('the Cursor signal never touches a Claude or Codex verdict', () => {
    const probes = withCursorComposerTurn(base(), () => signal() as never, () => 20_000, 30 * 60_000)
    expect(threadOccupancy('codex', CODEX, probes, dirs).reason).toBe('native_thread_working')
    expect(probes.cursorComposerTurnOpen!('not-an-id')).toBeNull()
  })
})
