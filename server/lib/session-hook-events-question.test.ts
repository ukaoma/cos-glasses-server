// X1: a session waiting on an AskUserQuestion says what it asks. `toolTarget` had no case for
// `questions`, so the row's waiting_detail was '' and Control Web read "Waiting for you. Paused until
// you answer." with no words (Miles's screenshot, 2026-11-09).
import { describe, expect, it } from 'vitest'
import { projectHookPayload, toolTarget } from './session-hook-events.js'
import { SessionSignalStore } from './session-signal-store.js'
import { ASK_INPUT, Q1, SESSION } from './__fixtures__/permission-broker.js'

describe('the question words on a waiting row', () => {
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
