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

const identity = { clientJobId: 'job-origin', generation: 1 }
const routine = { kind: 'routine' as const, id: 'morning-brief' }

describe('origin stamp on projected exchanges', () => {
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

  it('stamps both fields on insert', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.getOrCreateSession()
    const result = conversation.reconcileExchangeByJobIdentity(
      sid, identity, 'assistant', 'the brief', 78, undefined, undefined, null, routine,
    )
    expect(result.created).toBe(true)
    const [exchange] = conversation.findExchangesByJobIdentity(sid, identity)
    expect(exchange.origin).toBe('routine')
    expect(exchange.originId).toBe('morning-brief')
  })

  it('keeps the stamp when an unstamped reconcile updates the same half (the mid-run bridge case)', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.getOrCreateSession()
    conversation.reconcileExchangeByJobIdentity(
      sid, identity, 'user', 'prompt', 78, undefined, undefined, null, routine,
    )
    // cursor-bridge / ollama-bridge reconcile with EIGHT positionals and no origin.
    conversation.reconcileExchangeByJobIdentity(sid, identity, 'user', 'prompt again', 78)
    const [exchange] = conversation.findExchangesByJobIdentity(sid, identity)
    expect(exchange.content).toBe('prompt again')
    expect(exchange.origin).toBe('routine')
    expect(exchange.originId).toBe('morning-brief')
  })

  it('validates the stamp at the load boundary: unknown kinds and orphan ids are dropped, real stamps survive', async () => {
    const now = Date.now()
    disk.loaded = {
      status: 'ok',
      data: {
        sessions: {
          loaded: {
            id: 'loaded',
            exchanges: [
              { role: 'assistant', content: 'unknown kind', timestamp: now, origin: 'maintenance', originId: 'x' },
              { role: 'assistant', content: 'routine without id', timestamp: now, origin: 'routine' },
              { role: 'assistant', content: 'task with empty id', timestamp: now, origin: 'task', originId: '' },
              { role: 'assistant', content: 'the brief', timestamp: now, origin: 'routine', originId: 'morning-brief' },
              { role: 'assistant', content: 'plain', timestamp: now },
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
    const history = conversation.getHistory('loaded')
    expect(history.map(ex => [ex.content, ex.origin ?? null, ex.originId ?? null])).toEqual([
      ['unknown kind', null, null],
      ['routine without id', 'routine', null],
      ['task with empty id', 'task', null],
      ['the brief', 'routine', 'morning-brief'],
      ['plain', null, null],
    ])
  })

  it('gains the stamp when a stamped reconcile updates an unstamped insert (the terminal projection)', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.getOrCreateSession()
    conversation.reconcileExchangeByJobIdentity(sid, identity, 'user', 'prompt', 78)
    conversation.reconcileExchangeByJobIdentity(
      sid, identity, 'user', 'prompt', 78, undefined, undefined, null, { kind: 'task', id: 'a3f19c0b2d4e' },
    )
    const [exchange] = conversation.findExchangesByJobIdentity(sid, identity)
    expect(exchange.origin).toBe('task')
    expect(exchange.originId).toBe('a3f19c0b2d4e')
  })
})
