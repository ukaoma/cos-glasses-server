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

  it('never stamps a human exchange', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.getOrCreateSession()
    conversation.addExchange(sid, 'user', 'typed on the phone', 5)
    conversation.addExchange(sid, 'assistant', 'answer', 5)
    for (const exchange of conversation.getHistory(sid)) {
      expect(exchange.origin).toBeUndefined()
      expect(exchange.originId).toBeUndefined()
    }
  })
})
