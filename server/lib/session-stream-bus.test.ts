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

    expect(a).toEqual([{ kind: 'status', state: 'working', at: 1000 }])
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
