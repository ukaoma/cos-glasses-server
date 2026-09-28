import { expect, it, vi } from 'vitest'
import { CONTINUE_AT, FORK_AT, RECOMMENDATION_LIMITS, SessionRecommender, decide, parseCandidates } from './session-recommendation.js'
import { JevError } from './jev.js'

const sessions = [{ id: 'claude:a', provider: 'claude', title: 'Bottle POS hardware slider' },
                  { id: 'claude:b', provider: 'claude', title: 'COS-glasses Server work (meetings)' },
                  { id: 'codex:c', provider: 'codex', title: 'Reconnect Oura dev API token' }]

it('continues where a session is already doing the task, forks shared context, and starts new otherwise', () => {
  // Measured 2026-09-28: server bug → continue at 0.91; hardware scenes → fork; a 1:1 → new (none 0.73).
  expect(decide({ s1: 0.95, s0: 0.05, none: 0 }, { s1: 0.91, none: 0.09 }, sessions)).toMatchObject({ action: 'continue', sessionId: 'claude:b', confidence: 0.91 })
  expect(decide({ s0: 0.5, s1: 0.48, none: 0.02 }, { s0: 0.39, none: 0.38 }, sessions)).toMatchObject({ action: 'fork', sessionId: 'claude:a', confidence: 0.98 })
  expect(decide({ s0: 0.17, none: 0.73 }, { none: 0.94, s0: 0.03 }, sessions)).toMatchObject({ action: 'new', sessionId: null, confidence: 0.73 })
  // The thresholds, exactly at and just under.
  expect(decide({ s0: 1 - FORK_AT, none: FORK_AT }, { none: 1 }, sessions).action).toBe('new')
  expect(decide({ s0: FORK_AT, none: 1 - FORK_AT }, { s0: CONTINUE_AT - 0.01, none: 0.51 }, sessions).action).toBe('fork')
  expect(decide({ s0: FORK_AT, none: 1 - FORK_AT }, { s2: CONTINUE_AT, none: 0.5 }, sessions)).toMatchObject({ action: 'continue', sessionId: 'codex:c' })
  expect(decide({ s0: 0.6, s1: 0.3, s2: 0.1 }, {}, sessions).alternatives.map(a => a.sessionId)).toEqual(['claude:a', 'claude:b', 'codex:c'])
})

it('refuses an answer that names a session that was not offered', () => {
  expect(() => decide({ s9: 0.9, none: 0.1 }, { none: 1 }, sessions)).toThrow(JevError)
  expect(() => decide({ none: 1 }, { s3: 0.9 }, sessions)).toThrow(JevError)
})

it('validates candidate sessions: bounded, titled, unique', () => {
  expect(parseCandidates(sessions)).toHaveLength(3)
  expect(parseCandidates([{ ...sessions[0], title: '  a\\n b  ', summary: 'x'.repeat(500) }])![0]).toMatchObject({ title: 'a\\n b', summary: 'x'.repeat(RECOMMENDATION_LIMITS.summary) })
  for (const bad of [[{ id: 'x' }], [sessions[0], sessions[0]], [{ ...sessions[0], id: '' }], 'x', Array.from({ length: RECOMMENDATION_LIMITS.sessions + 1 }, (_, i) => ({ id: 'id' + i, title: 't' }))]) {
    expect(parseCandidates(bad)).toBeNull()
  }
})

it('asks once, caches the answer for the same task and sessions, and degrades to none without Jev', async () => {
  const ask = vi.fn(async () => ({ model: 'jev-1.13.0', inputTokens: 10, answers: { best: { probabilities: { s1: 0.95, none: 0.05 } }, exact: { probabilities: { s1: 0.91, none: 0.09 } } } }))
  let now = 0
  const r = new SessionRecommender({ ask } as any, () => now)
  const input = { task: { text: 'Fix the meeting link refusal', domain: 'personal', meetings: ['Server QA'] }, sessions }
  expect(await r.recommend(input)).toMatchObject({ provider: 'jev', action: 'continue', sessionId: 'claude:b', cached: false })
  expect(await r.recommend(input)).toMatchObject({ cached: true })
  expect(ask).toHaveBeenCalledTimes(1)
  const [state, questions] = ask.mock.calls[0] as any
  expect(state.task).toEqual({ text: 'Fix the meeting link refusal', domain: 'personal', meetings: ['Server QA'] })
  expect(Object.keys(questions)).toEqual(['best', 'exact'])
  expect(Object.keys(questions.best.criteria)).toEqual(['s0', 's1', 's2', 'none'])
  now = RECOMMENDATION_LIMITS.cacheMs + 1
  await r.recommend(input); expect(ask).toHaveBeenCalledTimes(2)  // expired
  const down = new SessionRecommender({ ask: vi.fn(async () => { throw new JevError('jev_not_configured') }) } as any)
  expect(await down.recommend(input)).toEqual({ provider: 'none', reason: 'jev_not_configured' })
  expect(await r.recommend({ ...input, sessions: [] })).toEqual({ provider: 'none', reason: 'no_sessions' })
})
