import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({
  loaded: { status: 'missing' as const } as unknown,
  saved: '' as string,
}))

vi.mock('./atomic-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-fs.js')>()
  return {
    ...actual,
    loadJsonOrQuarantine: vi.fn(() => disk.loaded),
    atomicWriteFileSync: vi.fn((_path: string, data: string) => {
      disk.saved = data
    }),
  }
})

describe('durable conversation exchange provenance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    disk.loaded = { status: 'missing' }
    disk.saved = ''
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.resetModules()
  })

  it('removes only the matching failed-job user turn', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    const failed = { clientJobId: 'job-shared', generation: 1 }
    const retry = { clientJobId: 'job-shared', generation: 2 }
    const other = { clientJobId: 'job-other', generation: 1 }

    conversation.addExchange(sid, 'user', 'identical prompt', 42, undefined, failed)
    conversation.addExchange(sid, 'assistant', 'partial durable answer', 42, undefined, failed)
    conversation.addExchange(sid, 'user', 'identical prompt', 42, undefined, retry)
    conversation.addExchange(sid, 'user', 'identical prompt', 42, undefined, other)

    expect(conversation.removeExchangesByJobIdentity(sid, failed, 'user')).toBe(1)
    expect(conversation.findExchangesByJobIdentity(sid, failed).map(ex => ex.role)).toEqual(['assistant'])
    expect(conversation.findExchangesByJobIdentity(sid, retry).map(ex => ex.role)).toEqual(['user'])
    expect(conversation.findExchangesByJobIdentity(sid, other).map(ex => ex.role)).toEqual(['user'])
  })

  it('reconciles roles idempotently without crossing retry generations', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    const identity = { clientJobId: 'job-reconcile', generation: 3 }

    conversation.addExchange(sid, 'user', 'stale prompt', 7, undefined, identity)
    conversation.addExchange(sid, 'user', 'duplicate prompt', 7, undefined, identity)
    conversation.addExchange(sid, 'user', 'newer generation', 7, undefined, {
      clientJobId: identity.clientJobId,
      generation: 4,
    })

    expect(conversation.reconcileExchangeByJobIdentity(
      sid, identity, 'user', 'canonical prompt', 7,
    ).created).toBe(false)
    expect(conversation.reconcileExchangeByJobIdentity(
      sid, identity, 'assistant', 'canonical answer', 7,
    ).created).toBe(true)
    expect(conversation.reconcileExchangeByJobIdentity(
      sid, identity, 'assistant', 'canonical answer', 7,
    ).created).toBe(false)

    expect(conversation.findExchangesByJobIdentity(sid, identity).map(ex => [ex.role, ex.content])).toEqual([
      ['user', 'canonical prompt'],
      ['assistant', 'canonical answer'],
    ])
    expect(conversation.findExchangesByJobIdentity(sid, {
      clientJobId: identity.clientJobId,
      generation: 4,
    })).toHaveLength(1)
  })

  it('persists and reloads valid provenance without changing the message era', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    const identity = { clientJobId: '12345678-1234-4123-8123-123456789abc', generation: 5 }
    const user = conversation.addExchange(sid, 'user', 'durable prompt', 99, undefined, identity)
    conversation.addExchange(sid, 'assistant', 'durable answer', 99, undefined, identity)
    await vi.advanceTimersByTimeAsync(500)

    const persisted = JSON.parse(disk.saved)
    expect(persisted.sessions[sid].exchanges).toMatchObject([
      { role: 'user', clientJobId: identity.clientJobId, generation: 5, messageEra: user.messageEra },
      { role: 'assistant', clientJobId: identity.clientJobId, generation: 5 },
    ])

    disk.loaded = { status: 'ok', data: persisted }
    vi.resetModules()
    const reloaded = await import('./conversation.js')
    expect(reloaded.findExchangesByJobIdentity(sid, identity).map(ex => ex.content)).toEqual([
      'durable prompt',
      'durable answer',
    ])
    expect(reloaded.getHistory(sid)[0].messageEra).toBe(user.messageEra)
  })

  it('drops malformed provenance while preserving otherwise valid exchanges', async () => {
    const now = Date.now()
    disk.loaded = {
      status: 'ok',
      data: {
        sessions: {
          loaded: {
            id: 'loaded',
            exchanges: [
              { role: 'user', content: 'bad id', timestamp: now, clientJobId: '../private', generation: 1 },
              { role: 'assistant', content: 'bad generation', timestamp: now, clientJobId: 'job-safe', generation: 0 },
            ],
            lastActivity: now,
            createdAt: now,
            modelPreference: null,
            contextBreaks: [],
          },
        },
        savedAt: new Date(now).toISOString(),
      },
    }

    const conversation = await import('./conversation.js')
    expect(conversation.getHistory('loaded')).toMatchObject([
      { role: 'user', content: 'bad id' },
      { role: 'assistant', content: 'bad generation', clientJobId: 'job-safe' },
    ])
    expect(conversation.getHistory('loaded')[0]).not.toHaveProperty('clientJobId')
    expect(conversation.getHistory('loaded')[0]).not.toHaveProperty('generation')
    expect(conversation.getHistory('loaded')[1]).not.toHaveProperty('generation')
  })

  it('rejects invalid exact identities without mutating a session', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    conversation.addExchange(sid, 'user', 'legacy prompt', 1)

    expect(conversation.findExchangesByJobIdentity(sid, {
      clientJobId: '../unsafe', generation: 1,
    })).toEqual([])
    expect(conversation.removeExchangesByJobIdentity(sid, {
      clientJobId: 'job-safe', generation: 0,
    })).toBe(0)
    expect(() => conversation.reconcileExchangeByJobIdentity(
      sid, { clientJobId: 'job-safe', generation: 0 }, 'assistant', 'answer', 1,
    )).toThrow('invalid durable job identity')
    expect(conversation.getHistory(sid)).toHaveLength(1)
  })
})
