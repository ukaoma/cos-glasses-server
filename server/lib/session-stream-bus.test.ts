import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_STREAMED_SESSIONS,
  MAX_SUBSCRIBERS_PER_SESSION,
  __resetSessionStreamBusForTests,
  beginAttachedTurn,
  isAttachedTurnActive,
  publishSessionStream,
  sessionStreamKey,
  streamedSessionCount,
  subscribeSessionStream,
  subscriberCount,
  type PublishedSessionEvent,
  replaySessionStream,
  ringBounds,
  sweepSessionRings,
  RING_MAX,
  RING_HARD_MAX,
  RING_LINGER_MS,
} from './session-stream-bus'

const A = sessionStreamKey('claude', 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d')
const B = sessionStreamKey('codex', '019fc80a-cc79-7921-8541-298e71695afd')

afterEach(() => __resetSessionStreamBusForTests())

describe('one session is not another session', () => {
  it('delivers only to subscribers of the published key', () => {
    const a: PublishedSessionEvent[] = []
    const b: PublishedSessionEvent[] = []
    subscribeSessionStream(A, e => a.push(e))
    subscribeSessionStream(B, e => b.push(e))

    publishSessionStream(A, { kind: 'status', state: 'working' }, 1000)

    expect(a).toEqual([{ kind: 'status', state: 'working', at: 1000, cursor: 1 }])
    expect(b).toEqual([])
  })

  it('normalizes the key so casing cannot split one session in two', () => {
    expect(sessionStreamKey('Claude', 'A4B2B4DD-E40C-4B08-8A11-C89A018C197D')).toBe(A)
    expect(sessionStreamKey(' claude ', ' a4b2b4dd-e40c-4b08-8a11-c89a018c197d ')).toBe(A)
  })

  it('publishing to a key with no subscribers is a no-op, not an error', () => {
    expect(publishSessionStream('claude:nobody', { kind: 'heartbeat' })).toBe(0)
  })
})

describe('a broken subscriber costs only itself', () => {
  it('keeps delivering to the others when one listener throws', () => {
    const good: PublishedSessionEvent[] = []
    subscribeSessionStream(A, () => { throw new Error('socket gone') })
    subscribeSessionStream(A, e => good.push(e))

    expect(() => publishSessionStream(A, { kind: 'heartbeat' })).not.toThrow()
    expect(good).toHaveLength(1)
  })

  it('lets a listener unsubscribe itself mid-notify without losing its peer', () => {
    const seen: string[] = []
    let release: (() => void) | null = null
    release = subscribeSessionStream(A, () => { seen.push('first'); release?.() })
    subscribeSessionStream(A, () => seen.push('second'))

    publishSessionStream(A, { kind: 'heartbeat' })

    expect(seen).toEqual(['first', 'second'])
    expect(subscriberCount(A)).toBe(1)
  })
})

describe('unsubscribe', () => {
  it('stops delivery and releases the key when the last one leaves', () => {
    const seen: PublishedSessionEvent[] = []
    const release = subscribeSessionStream(A, e => seen.push(e))!
    publishSessionStream(A, { kind: 'heartbeat' })
    release()
    publishSessionStream(A, { kind: 'heartbeat' })

    expect(seen).toHaveLength(1)
    expect(streamedSessionCount()).toBe(0)
  })

  it('is idempotent, so a close handler that fires twice cannot evict a peer', () => {
    const release = subscribeSessionStream(A, () => {})!
    subscribeSessionStream(A, () => {})
    release()
    release()
    release()
    expect(subscriberCount(A)).toBe(1)
  })
})

describe('ceilings', () => {
  it('refuses a subscriber past the per-session limit', () => {
    for (let i = 0; i < MAX_SUBSCRIBERS_PER_SESSION; i++) {
      expect(subscribeSessionStream(A, () => {})).not.toBeNull()
    }
    expect(subscribeSessionStream(A, () => {})).toBeNull()
  })

  it('refuses a NEW session past the global limit but still admits an existing one', () => {
    for (let i = 0; i < MAX_STREAMED_SESSIONS; i++) {
      expect(subscribeSessionStream(`claude:s${i}`, () => {})).not.toBeNull()
    }
    expect(subscribeSessionStream('claude:one-too-many', () => {})).toBeNull()
    // A second pair of glasses on a session already streaming is not a new watcher.
    expect(subscribeSessionStream('claude:s0', () => {})).not.toBeNull()
  })
})

describe('the duplicate-suppression gate', () => {
  it('is off until a turn opens it and off again once it closes', () => {
    expect(isAttachedTurnActive(A)).toBe(false)
    const end = beginAttachedTurn(A)
    expect(isAttachedTurnActive(A)).toBe(true)
    end()
    expect(isAttachedTurnActive(A)).toBe(false)
  })

  it('is scoped to its own session', () => {
    const end = beginAttachedTurn(A)
    expect(isAttachedTurnActive(B)).toBe(false)
    end()
  })

  it('counts, so one turn ending does not unlock a second still running', () => {
    const first = beginAttachedTurn(A)
    const second = beginAttachedTurn(A)
    first()
    expect(isAttachedTurnActive(A)).toBe(true)
    second()
    expect(isAttachedTurnActive(A)).toBe(false)
  })

  it('cannot be driven negative by a double release', () => {
    const end = beginAttachedTurn(A)
    end()
    end()
    end()
    expect(isAttachedTurnActive(A)).toBe(false)
    // A gate stuck below zero would refuse to engage for the NEXT turn.
    const again = beginAttachedTurn(A)
    expect(isAttachedTurnActive(A)).toBe(true)
    again()
  })
})

describe('the per-session replay ring (6.48.1)', () => {
  it('stamps a per-session cursor, replays after a cursor, and forgets a session after the linger', () => {
    __resetSessionStreamBusForTests()
    const key = sessionStreamKey('claude', 'a1b2c3d4-0000-4000-8000-000000000001')
    const seen: unknown[] = []
    const release = subscribeSessionStream(key, e => seen.push(e))!
    publishSessionStream(key, { kind: 'prompt', text: 'q' }, 1)
    publishSessionStream(key, { kind: 'tool', verb: 'read', target: 'a', detail: '' }, 2)
    publishSessionStream(key, { kind: 'prose', text: 'x' }, 3)
    expect(seen.map(e => (e as { cursor: number }).cursor)).toEqual([1, 2, 3])
    expect(replaySessionStream(key, 1).map(e => e.cursor)).toEqual([2, 3])
    expect(replaySessionStream(key, 3)).toEqual([])
    expect(replaySessionStream('claude:other', 0)).toEqual([])
    expect(ringBounds(key)).toEqual({ oldest: 1, newest: 3 })
    // Another session's cursor space is its own.
    const other = sessionStreamKey('claude', 'b2c3d4e5-0000-4000-8000-000000000002')
    const releaseOther = subscribeSessionStream(other, () => {})!
    publishSessionStream(other, { kind: 'heartbeat' }, 4)
    expect(ringBounds(other)).toEqual({ oldest: 1, newest: 1 })
    releaseOther()
    release()
    // Nothing is dropped inside the linger, and a reconnect within it reads the gap.
    expect(sweepSessionRings(Date.now())).toBe(0)
    expect(replaySessionStream(key, 1).map(e => e.cursor)).toEqual([2, 3])
    expect(sweepSessionRings(Date.now() + RING_LINGER_MS + 1)).toBe(2)
    expect(ringBounds(key)).toBeNull()
  })

  it('keeps the last RING_MAX events, never cutting into the active turn until the hard cap', () => {
    __resetSessionStreamBusForTests()
    const key = sessionStreamKey('claude', 'a1b2c3d4-0000-4000-8000-000000000003')
    subscribeSessionStream(key, () => {})
    for (let i = 0; i < RING_MAX + 50; i++) publishSessionStream(key, { kind: 'heartbeat' }, i)
    expect(ringBounds(key)).toEqual({ oldest: 51, newest: RING_MAX + 50 })
    // A prompt opens a turn; the turn's steps outgrow RING_MAX and are all kept...
    publishSessionStream(key, { kind: 'prompt', text: 'turn' }, 0)
    const promptCursor = ringBounds(key)!.newest
    for (let i = 0; i < RING_MAX + 100; i++) publishSessionStream(key, { kind: 'tool', verb: 'read', target: String(i), detail: '' }, i)
    expect(ringBounds(key)!.oldest).toBe(promptCursor)
    expect(replaySessionStream(key, promptCursor).length).toBe(RING_MAX + 100)
    // ...up to the hard cap. A turn longer than that cannot be kept whole: the ring
    // falls back to the newest RING_MAX and a reconnecting client reseeds.
    for (let i = 0; i < RING_HARD_MAX; i++) publishSessionStream(key, { kind: 'tool', verb: 'read', target: 'x', detail: '' }, i)
    expect(replaySessionStream(key, 0).length).toBe(RING_MAX)
    expect(replaySessionStream(key, 0).some(e => e.kind === 'prompt')).toBe(false)
  })
})
