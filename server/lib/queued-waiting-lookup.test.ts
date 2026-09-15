import { describe, expect, it } from 'vitest'
import { queuedTurnsFields, queuedWaitingForSession } from './thread-turn-queue-store.js'

const FULL = 'a1b2c3d4-0000-4000-8000-000000000001'
const OTHER = 'a1b2c3d4-1111-4000-8000-000000000002'

describe('queuedWaitingForSession', () => {
  it('counts an exact native id', () => {
    expect(queuedWaitingForSession(
      [{ provider: 'claude', threadId: FULL, waiting: 2 }],
      'claude', FULL,
    )).toBe(2)
  })

  it('an 8-character registry id counts a unique prefix, and refuses when two ids share it', () => {
    expect(queuedWaitingForSession(
      [{ provider: 'claude', threadId: FULL, waiting: 1 }],
      'claude', FULL.slice(0, 8),
    )).toBe(1)
    expect(queuedWaitingForSession(
      [
        { provider: 'claude', threadId: FULL, waiting: 1 },
        { provider: 'claude', threadId: OTHER, waiting: 1 },
      ],
      'claude', FULL.slice(0, 8),
    )).toBe(0)
  })

  it('does not mix providers, and omits a zero rather than stamping 0', () => {
    expect(queuedWaitingForSession(
      [{ provider: 'codex', threadId: FULL, waiting: 1 }],
      'claude', FULL,
    )).toBe(0)
    expect(queuedWaitingForSession(
      [{ provider: 'cursor', threadId: FULL, waiting: 0 }],
      'cursor', FULL,
    )).toBe(0)
    expect(queuedTurnsFields(2)).toEqual({ queued_turns: 2 })
    expect(queuedTurnsFields(0)).toEqual({})
  })
})
