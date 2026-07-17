import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmp = ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  tmp = mkdtempSync(join(tmpdir(), 'cos-conversation-'))
  process.env.COS_DATA_DIR = tmp
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.resetModules()
  delete process.env.COS_DATA_DIR
  rmSync(tmp, { recursive: true, force: true })
})

describe('conversation exchange identity', () => {
  it('returns the inserted object and removes only that exact duplicate', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    const first = conversation.addExchange(sid, 'user', 'identical prompt', 42)
    const second = conversation.addExchange(sid, 'user', 'identical prompt', 42)

    expect(first).not.toBe(second)
    expect(conversation.getHistory(sid)).toEqual([first, second])
    expect(conversation.removeExchange(sid, second)).toBe(true)
    expect(conversation.removeExchange(sid, second)).toBe(false)
    expect(conversation.getHistory(sid)).toEqual([first])

    await vi.advanceTimersByTimeAsync(500)
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

    await vi.advanceTimersByTimeAsync(500)
  })

  it('reconciles each job role idempotently and collapses only exact-identity duplicates', async () => {
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

    await vi.advanceTimersByTimeAsync(500)
  })

  it('persists and reloads valid job provenance through the sessions schema', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    const identity = { clientJobId: '12345678-1234-4123-8123-123456789abc', generation: 5 }
    conversation.addExchange(sid, 'user', 'durable prompt', 99, undefined, identity)
    conversation.addExchange(sid, 'assistant', 'durable answer', 99, undefined, identity)
    await vi.advanceTimersByTimeAsync(500)

    const persisted = JSON.parse(readFileSync(join(tmp, 'sessions.json'), 'utf8'))
    expect(persisted.sessions[sid].exchanges).toMatchObject([
      { role: 'user', clientJobId: identity.clientJobId, generation: 5 },
      { role: 'assistant', clientJobId: identity.clientJobId, generation: 5 },
    ])

    vi.resetModules()
    const reloaded = await import('./conversation.js')
    expect(reloaded.findExchangesByJobIdentity(sid, identity).map(ex => ex.content)).toEqual([
      'durable prompt',
      'durable answer',
    ])
  })

  it('flushes a terminal projection immediately with private file mode', async () => {
    const conversation = await import('./conversation.js')
    const sid = conversation.createSession()
    conversation.addExchange(sid, 'user', 'fsync prompt', 17, undefined, {
      clientJobId: '12345678-1234-4123-8123-123456789abc',
      generation: 1,
    })
    conversation.flushConversationToDisk()

    const path = join(tmp, 'sessions.json')
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.sessions[sid].exchanges[0].content).toBe('fsync prompt')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('drops malformed provenance fields while loading otherwise valid exchanges', async () => {
    const now = Date.now()
    writeFileSync(join(tmp, 'sessions.json'), JSON.stringify({
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
    }))

    const conversation = await import('./conversation.js')
    expect(conversation.getHistory('loaded')).toMatchObject([
      { role: 'user', content: 'bad id' },
      { role: 'assistant', content: 'bad generation', clientJobId: 'job-safe' },
    ])
    expect(conversation.getHistory('loaded')[0]).not.toHaveProperty('clientJobId')
    expect(conversation.getHistory('loaded')[0]).not.toHaveProperty('generation')
    expect(conversation.getHistory('loaded')[1]).not.toHaveProperty('generation')
  })
})
