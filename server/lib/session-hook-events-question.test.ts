// X1: a session waiting on an AskUserQuestion says what it asks. `toolTarget` had no case for
// `questions`, so the row's waiting_detail was '' and Control Web read "Waiting for you. Paused until
// you answer." with no words (Miles's screenshot, 2026-11-09).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectHookPayload, toolTarget } from './session-hook-events.js'
import { SessionSignalStore } from './session-signal-store.js'
import { ASK_INPUT, Q1, SESSION } from './__fixtures__/permission-broker.js'

const saved = process.env.COS_WAITING_QUESTION_WORDS
afterEach(() => { if (saved === undefined) delete process.env.COS_WAITING_QUESTION_WORDS; else process.env.COS_WAITING_QUESTION_WORDS = saved })

describe('COS_WAITING_QUESTION_WORDS=0: 7.0.13, no words anywhere', () => {
  it('a question\'s target is empty, in the projection and on the row', () => {
    process.env.COS_WAITING_QUESTION_WORDS = '0'
    expect(toolTarget(ASK_INPUT)).toBe('')
    const payload = { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }
    expect(projectHookPayload('PreToolUse', payload).tool_target).toBe('')
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    store.apply({ ts: 1_000, ppid: 1, sessionId: SESSION, event: 'PreToolUse', payload }, false)
    expect(store.get(SESSION)?.waiting).toMatchObject({ kind: 'question', detail: '' })
    for (const off of ['false', 'off', ' OFF ']) { process.env.COS_WAITING_QUESTION_WORDS = off; expect(toolTarget(ASK_INPUT)).toBe('') }
  })
})

describe('the default (Miles 22:10, "Yes, show by default"): words on', () => {
  it('unset, the first question shows; only its text, never an option or description, control and format characters out', () => {
    delete process.env.COS_WAITING_QUESTION_WORDS
    expect(toolTarget(ASK_INPUT)).toBe(Q1.trim())
    const sneaky = { questions: [{ question: 'Deploy\u202e now?\u0007\u200b', options: [{ label: 'SECRET-OPTION', description: 'SECRET-DESC' }] }, { question: 'Second question' }] }
    const target = toolTarget(sneaky)
    expect(target).toBe('Deploy now?')
    expect(target).not.toMatch(/SECRET|Second/)
  })
  it('the settled question leaves the row: PostToolUse clears the waiting detail', () => {
    delete process.env.COS_WAITING_QUESTION_WORDS
    const payload = { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    store.apply({ ts: 1_000, ppid: 1, sessionId: SESSION, event: 'PreToolUse', payload }, false)
    expect(store.get(SESSION)?.waiting?.detail).toBe(Q1.trim())
    store.apply({ ts: 2_000, ppid: 1, sessionId: SESSION, event: 'PostToolUse', payload }, false)
    expect(store.get(SESSION)?.waiting ?? null).toBeNull()
  })
})

describe('the question words on a waiting row (COS_WAITING_QUESTION_WORDS=1)', () => {
  beforeEach(() => { process.env.COS_WAITING_QUESTION_WORDS = '1' })
  it('a question\'s target is its first question, clipped to 80', () => {
    expect(toolTarget(ASK_INPUT)).toBe(Q1.trim())
    const long = 'x'.repeat(120)
    expect(toolTarget({ questions: [{ question: long, options: [] }] })).toBe('x'.repeat(79) + '…')
  })
  it('every earlier field still wins, and nonsense is still nothing', () => {
    expect(toolTarget({ command: 'ls', questions: [{ question: 'Q?' }] })).toBe('ls')
    for (const input of [{ questions: [] }, { questions: 'Q?' }, { questions: [null] }, { questions: [{ question: '   ' }] }, { questions: [{ question: 7 }] }]) expect(toolTarget(input)).toBe('')
  })
  it('the ledger projection and the signal store carry it', () => {
    const payload = { session_id: SESSION, tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, tool_use_id: 'toolu_q1' }
    expect(projectHookPayload('PreToolUse', payload).tool_target).toBe(Q1.trim())
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    store.apply({ ts: 1_000, ppid: 1, sessionId: SESSION, event: 'PreToolUse', payload }, false)
    expect(store.get(SESSION)?.waiting).toMatchObject({ kind: 'question', detail: Q1.trim() })
  })
})
