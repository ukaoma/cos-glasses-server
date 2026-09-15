// The four stores, their ids, their tombstones, and the one mutex that owns them.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AsyncMutex,
  MAX_ACTIONS,
  MeetingActionsStore,
  STORE_SCHEMA,
  type CanonicalInputs,
  type MergeActionRecord,
  actionIdFor,
  canonicalIdList,
  inputPairs,
  isTombstoned,
  pairKey,
  suggestionIdFor,
} from './meeting-actions-store.js'

const roots: string[] = []

function store(): MeetingActionsStore {
  const dir = mkdtempSync(join(tmpdir(), 'cos-actions-'))
  roots.push(dir)
  return new MeetingActionsStore({ root: join(dir, 'imports') })
}

const set = (sessionIds: string[], firefliesIds: string[]): CanonicalInputs => ({ sessionIds, firefliesIds })

function action(id: string, overrides: Partial<MergeActionRecord> = {}): MergeActionRecord {
  return {
    id,
    kind: 'merge',
    tier: 'auto',
    inputs: set(['s1'], ['f1']),
    fingerprints: 'fp',
    outputs: [],
    outputSha256: [],
    state: 'applied',
    mode: 'imports',
    at: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('canonical ids', () => {
  it('do not depend on the order the engine visited inputs in', () => {
    expect(actionIdFor('merge', set(['b', 'a'], ['y', 'x'])))
      .toBe(actionIdFor('merge', set(['a', 'b'], ['x', 'y'])))
  })

  it('keep G2 and Fireflies namespaces apart', () => {
    expect(actionIdFor('merge', set(['x'], []))).not.toBe(actionIdFor('merge', set([], ['x'])))
  })

  it('are different per kind', () => {
    expect(actionIdFor('merge', set(['s1'], ['f1']))).not.toBe(actionIdFor('split', set(['s1'], ['f1'])))
  })

  it('carry the prefix each surface routes on', () => {
    expect(actionIdFor('merge', set(['s1'], ['f1']))).toMatch(/^a_[0-9a-f]{16}$/)
    expect(suggestionIdFor('merge', set(['s1'], ['f1']))).toMatch(/^s_[0-9a-f]{16}$/)
  })

  it('separate a session id that contains the list separator', () => {
    // Session ids may contain a colon. A separator that can appear inside a part is a
    // separator that lets two different input sets hash to one id.
    expect(canonicalIdList(set(['a:b'], []))).toEqual(['g2:a:b'])
    expect(actionIdFor('merge', set(['a', 'b'], []))).not.toBe(actionIdFor('merge', set(['a,b'], [])))
  })
})

describe('tombstones are pairs', () => {
  it('enumerates every unordered pair', () => {
    expect(inputPairs(set(['s1', 's2'], ['f1'])).map(pairKey).sort())
      .toEqual(['ff:f1|g2:s1', 'ff:f1|g2:s2', 'g2:s1|g2:s2'])
  })

  it('makes a single input its own pair so it can be blocked at all', () => {
    expect(inputPairs(set([], ['f1']))).toEqual([['ff:f1', 'ff:f1']])
  })

  it('blocks a WIDER set that contains a refused pair', () => {
    // The whole point: refusing "this capture is not that meeting" must also refuse the
    // three-way merge that sweeps the same wrong pair in alongside a second capture.
    const tombstones = [{ pair: ['g2:s1', 'ff:f1'] as [string, string], at: 'now' }]
    expect(isTombstoned(tombstones, set(['s1', 's2'], ['f1']))).toBe(true)
  })

  it('leaves an unrelated set alone', () => {
    const tombstones = [{ pair: ['g2:s1', 'ff:f1'] as [string, string], at: 'now' }]
    expect(isTombstoned(tombstones, set(['s2'], ['f2']))).toBe(false)
    expect(isTombstoned(tombstones, set(['s1'], ['f2']))).toBe(false)
  })

  it('does not care which way round the pair was written', () => {
    const tombstones = [{ pair: ['ff:f1', 'g2:s1'] as [string, string], at: 'now' }]
    expect(isTombstoned(tombstones, set(['s1'], ['f1']))).toBe(true)
  })

  it('blocks a dismissed split without blocking merging the same recording', () => {
    const tombstones = [{ pair: ['ff:f1', 'ff:f1'] as [string, string], at: 'now' }]
    expect(isTombstoned(tombstones, set([], ['f1']))).toBe(true)
    expect(isTombstoned(tombstones, set(['s1'], ['f1']))).toBe(false)
  })

  it('is cheap and false with no tombstones', () => {
    expect(isTombstoned([], set(['s1'], ['f1']))).toBe(false)
  })
})

describe('the store', () => {
  it('reads an empty store before anything is written', () => {
    const s = store()
    expect(s.read()).toMatchObject({ actions: [], suggestions: [], tombstones: [] })
  })

  it('writes 0600 files in a 0700 directory', async () => {
    const s = store()
    await s.update(current => { current.actions.push(action('a_1')) })
    expect(statSync(s.actionsPath()).mode & 0o777).toBe(0o600)
    expect(statSync(s.root).mode & 0o777).toBe(0o700)
  })

  it('only rewrites the files whose rows changed', async () => {
    const s = store()
    await s.update(current => { current.actions.push(action('a_1')) })
    const before = statSync(s.actionsPath()).mtimeMs
    // A status poll must not rewrite the action log: a file rewritten on every read is a
    // file iCloud syncs on every read.
    await new Promise(done => setTimeout(done, 12))
    await s.update(current => { current.status.engineInstalledAt = 1 })
    expect(statSync(s.actionsPath()).mtimeMs).toBe(before)
    expect(JSON.parse(readFileSync(s.statusPath(), 'utf8')).engineInstalledAt).toBe(1)
  })

  it('stamps the schema on every file it writes', async () => {
    const s = store()
    await s.update(current => {
      current.actions.push(action('a_1'))
      current.suggestions.push({ id: 's_1', kind: 'merge', inputs: set(['s1'], ['f1']), fingerprints: 'fp', evidence: { K1: 1, K2: 0 }, state: 'open', at: 'now' })
      current.tombstones.push({ pair: ['a', 'b'], at: 'now' })
      current.status.engineInstalledAt = 1
    })
    for (const path of [s.actionsPath(), s.suggestionsPath(), s.tombstonesPath(), s.statusPath()]) {
      expect(JSON.parse(readFileSync(path, 'utf8')).schema).toBe(STORE_SCHEMA)
    }
  })

  it('reads an unreadable store as empty without destroying the bytes', () => {
    const s = store()
    mkdirSync(s.root, { recursive: true, mode: 0o700 })
    writeFileSync(s.actionsPath(), '{not json', { flag: 'w' })
    expect(s.read().actions).toEqual([])
    // The corrupt bytes stay for a person to look at. A reader that deleted them would
    // destroy the only evidence of what went wrong.
    expect(readFileSync(s.actionsPath(), 'utf8')).toBe('{not json')
  })

  it('bounds how many rows it keeps', async () => {
    const s = store()
    await s.update(current => {
      for (let i = 0; i < MAX_ACTIONS + 10; i++) current.actions.push(action(`a_${i}`))
    })
    const kept = s.read().actions
    expect(kept).toHaveLength(MAX_ACTIONS)
    expect(kept[kept.length - 1].id).toBe(`a_${MAX_ACTIONS + 9}`)
  })
})

describe('the mutex is what makes this one writer', () => {
  it('serializes read-modify-write so nothing is lost', async () => {
    const s = store()
    // Without serialization every one of these reads the same empty store and writes one
    // row, and 19 of 20 disappear. This is the lost update that would quietly resurrect a
    // merge a person had refused.
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.update(current => {
      current.actions.push(action(`a_${i}`))
    })))
    expect(s.read().actions).toHaveLength(20)
  })

  it('serializes across the stores, not just within one', async () => {
    const s = store()
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.update(current => {
      current.tombstones.push({ pair: [`g2:s${i}`, 'ff:f1'], at: 'now' })
      current.suggestions.push({ id: `s_${i}`, kind: 'merge', inputs: set([`s${i}`], ['f1']), fingerprints: 'fp', evidence: { K1: 1, K2: 0 }, state: 'open', at: 'now' })
    })))
    const read = s.read()
    expect(read.tombstones).toHaveLength(10)
    expect(read.suggestions).toHaveLength(10)
  })

  it('lets a later update run after an earlier one threw', async () => {
    const s = store()
    await expect(s.update(() => { throw new Error('boom') })).rejects.toThrow('boom')
    // One failed update must never wedge every later one.
    await s.update(current => { current.actions.push(action('a_after')) })
    expect(s.read().actions.map(row => row.id)).toEqual(['a_after'])
  })

  it('awaits an async mutation before writing', async () => {
    const s = store()
    await s.update(async current => {
      await new Promise(done => setTimeout(done, 5))
      current.actions.push(action('a_async'))
    })
    expect(s.read().actions.map(row => row.id)).toEqual(['a_async'])
  })
})

describe('the mutex on its own', () => {
  it('never overlaps two pieces of work', async () => {
    const mutex = new AsyncMutex()
    let running = 0
    let maxConcurrent = 0
    await Promise.all(Array.from({ length: 8 }, () => mutex.run(async () => {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise(done => setTimeout(done, 2))
      running -= 1
    })))
    expect(maxConcurrent).toBe(1)
  })

  it('keeps order', async () => {
    const mutex = new AsyncMutex()
    const seen: number[] = []
    await Promise.all([3, 1, 2].map((n, index) => mutex.run(async () => {
      await new Promise(done => setTimeout(done, n))
      seen.push(index)
    })))
    expect(seen).toEqual([0, 1, 2])
  })

  it('delivers a rejection to its own caller and keeps going', async () => {
    const mutex = new AsyncMutex()
    const failed = mutex.run(() => { throw new Error('nope') })
    const after = mutex.run(() => 'ok')
    await expect(failed).rejects.toThrow('nope')
    await expect(after).resolves.toBe('ok')
  })
})
