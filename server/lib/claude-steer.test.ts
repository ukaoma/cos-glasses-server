// 6.78.0 Messages steer: the pure protocol module, against fixtures shaped like the live probe
// (pi_durable_build/probes/run1.json, Claude Code 2.1.302: one result covering both lines).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  STEER_REAPER_MS,
  STEER_SETTLE_MS,
  SteerPort,
  SteerTracker,
  composeFirstContent,
  encodeUserLine,
  providerOfModel,
  resolveRunModel,
  steerCutoffMs,
} from './claude-steer.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('the stdin protocol', () => {
  it('a user line is one JSON object and a newline, at the default priority (never "now")', () => {
    const line = encodeUserLine(B, 'Also check the tests.')
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({ type: 'user', uuid: B, parent_tool_use_id: null, message: { role: 'user', content: 'Also check the tests.' } })
    expect(line).not.toContain('priority')
  })

  it('the first prompt carries steers that came before it, and is the prompt unchanged without any', () => {
    expect(composeFirstContent('Summarize the README.', [])).toBe('Summarize the README.')
    expect(composeFirstContent('Summarize the README.', [{ text: '  ' }])).toBe('Summarize the README.')
    const composed = composeFirstContent('Summarize the README.', [{ text: 'also check the tests' }, { text: 'keep it short' }])
    expect(composed.startsWith('Summarize the README.\n\n')).toBe(true)
    expect(composed).toContain('- also check the tests\n- keep it short')
  })

  it('timing constants are the plan\'s', () => {
    expect(STEER_SETTLE_MS).toBe(20_000)
    expect(STEER_REAPER_MS).toBe(15_000)
    expect(steerCutoffMs(30_000)).toBe(10_000)
    expect(steerCutoffMs(20 * 60_000)).toBe(240_000)
  })
})

describe('the steer port (one per job, before the runner starts)', () => {
  it('buffers before the first line, drains into it, then writes directly, then refuses', () => {
    const port = new SteerPort()
    expect(port.offer({ steerId: A, text: 'early' })).toBe('pending')
    expect(port.drainForCompose()).toEqual([{ steerId: A, text: 'early' }])
    // Offered between the compose and the first write: written right behind the first line.
    expect(port.offer({ steerId: B, text: 'between' })).toBe('pending')
    const lines: string[] = []
    expect(port.open(line => { lines.push(line); return true }, { startedAt: 0, wallMaxMs: 60_000 })).toEqual([B])
    expect(port.offer({ steerId: C, text: 'live' })).toBe('written')
    expect(lines.map(line => JSON.parse(line).uuid)).toEqual([B, C])
    port.close()
    expect(port.offer({ steerId: '44444444-4444-4444-8444-444444444444', text: 'late' })).toBe('closed')
  })

  it('reports composed steers as included only once the first line is written', () => {
    const included: string[][] = []
    const port = new SteerPort({ onIncluded: steers => included.push(steers.map(s => s.steerId)) })
    port.offer({ steerId: A, text: 'one' })
    port.drainForCompose()
    expect(included).toEqual([])
    port.open(() => true, { startedAt: 0, wallMaxMs: 60_000 })
    expect(included).toEqual([[A]])
  })

  it('the same steer id is offered once (OO-2: a retried POST never writes a second line)', () => {
    const lines: string[] = []
    const port = new SteerPort()
    port.open(line => { lines.push(line); return true }, { startedAt: 0, wallMaxMs: 60_000 })
    expect(port.offer({ steerId: B, text: 'x' })).toBe('written')
    expect(port.offer({ steerId: B, text: 'x' })).toBe('duplicate')
    expect(lines).toHaveLength(1)
  })

  it('a sink that cannot write closes the port: that steer and every later one are refused', () => {
    const port = new SteerPort()
    port.open(() => false, { startedAt: 0, wallMaxMs: 60_000 })
    expect(port.offer({ steerId: B, text: 'x' })).toBe('closed')
    expect(port.isClosed).toBe(true)
    expect(port.offer({ steerId: C, text: 'y' })).toBe('closed')
  })

  it('knows the time left on the wall clock once the first line is written', () => {
    const port = new SteerPort()
    expect(port.wallRemainingMs(1_000)).toBeNull()
    port.open(() => true, { startedAt: 1_000, wallMaxMs: 60_000 })
    expect(port.wallRemainingMs(31_000)).toBe(30_000)
    expect(port.wallMax()).toBe(60_000)
  })
})

describe('the tracker (ST-1: finish only on coverage)', () => {
  it('a steer folded into the running turn: one result covers both lines and finishes the run', () => {
    const tracker = new SteerTracker(A)
    tracker.noteWritten(B)
    expect(tracker.onUserEvent({ type: 'user', uuid: A, isReplay: true } as never)).toBeNull()
    expect(tracker.onUserEvent({ type: 'user', uuid: B, isReplay: true } as never)).toBe(B)
    expect(tracker.onUserEvent({ type: 'user', uuid: B, isReplay: true } as never)).toBeNull()
    expect(tracker.onResult({ user_message_uuids: [A, B] })).toEqual({ action: 'finish', folded: [B] })
  })

  it('a "now"-style empty result covers nothing and does not finish', () => {
    const tracker = new SteerTracker(A)
    tracker.noteWritten(B)
    expect(tracker.onResult({ user_message_uuids: [] })).toEqual({ action: 'wait', folded: [], checkpoint: false })
  })

  it('the first turn covers the prompt only: wait, checkpoint once; the second turn covers the steer', () => {
    const tracker = new SteerTracker(A)
    tracker.noteWritten(B)
    expect(tracker.onResult({ user_message_uuids: [A] })).toEqual({ action: 'wait', folded: [], checkpoint: true })
    expect(tracker.uncovered()).toEqual([B])
    tracker.noteWritten(C)
    expect(tracker.onResult({ user_message_uuids: [B] })).toEqual({ action: 'wait', folded: [B], checkpoint: false })
    expect(tracker.onResult({ user_message_uuids: [C] })).toEqual({ action: 'finish', folded: [C] })
  })

  it('a result that does not say which lines it covers turns steering off: finish now', () => {
    const tracker = new SteerTracker(A)
    tracker.noteWritten(B)
    expect(tracker.onResult({})).toEqual({ action: 'finish_steering_off', folded: [] })
  })

  it('no steer at all: the first covering result finishes, as today', () => {
    expect(new SteerTracker(A).onResult({ user_message_uuids: [A] })).toEqual({ action: 'finish', folded: [] })
  })

  it('a replayed line that was never written, or not marked a replay, is not a delivery', () => {
    const tracker = new SteerTracker(A)
    expect(tracker.onUserEvent({ uuid: B, isReplay: true })).toBeNull()
    tracker.noteWritten(B)
    expect(tracker.onUserEvent({ uuid: B })).toBeNull()
  })

  it('the probe\'s own events read as a fold (run1.json shape)', () => {
    const tracker = new SteerTracker(A)
    // B written 1.5 s into the tool, replayed right after the tool_result, then one result.
    tracker.noteWritten(B)
    const events = [
      { type: 'user', uuid: A, isReplay: true },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      { type: 'user', uuid: B, isReplay: true },
    ]
    expect(events.map(event => tracker.onUserEvent(event as never))).toEqual([null, null, B])
    expect(tracker.onResult({ user_message_uuids: [A, B] }).action).toBe('finish')
  })
})

describe('the run model, resolved exactly as model-router resolves it', () => {
  it('request model, then the session\'s, then COS_G2_DEFAULT_MODEL, then the default', () => {
    expect(resolveRunModel('opus', 'haiku', 'sonnet')).toBe('opus')
    expect(resolveRunModel(undefined, 'haiku', 'opus')).toBe('haiku')
    expect(resolveRunModel('not-a-model', null, 'opus')).toBe('opus')
    expect(resolveRunModel(undefined, null, undefined)).toBe('sonnet')
  })

  it('pins the order model-router.ts uses (a change there must change this module too)', () => {
    const router = readFileSync(new URL('./model-router.ts', import.meta.url), 'utf8')
    expect(router).toContain('const resolvedModel = normalizeModelPreference(model) ?? sessionModel ?? envDefault ?? DEFAULT_MODEL')
    expect(router).toContain('const envDefault = normalizeModelPreference(process.env.COS_G2_DEFAULT_MODEL)')
  })

  it('the provider of a model, with anything else falling through to Claude', () => {
    expect(providerOfModel('opus')).toBe('claude')
    expect(providerOfModel('sonnet')).toBe('claude')
    expect(providerOfModel('codex-frontier')).toBe('codex')
    expect(providerOfModel('cursor-grok')).toBe('cursor')
    expect(providerOfModel('ollama')).toBe('ollama')
  })
})
