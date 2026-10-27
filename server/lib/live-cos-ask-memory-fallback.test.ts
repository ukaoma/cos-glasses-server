// 6.76.2: the Live COS Ask's COS search reads the memory bridge listing when memory search did not answer.
// Memory search is real (searchMemories over a COS scripts fixture); only the embedding subprocess is faked, so a
// "working" memory search is one that returns hits the way bot_memory.py does on Miles's Mac.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
const fixture = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const scripts = mkdtempSync(join(tmpdir(), 'ask-fallback-scripts-'))
  mkdirSync(join(scripts, 'venv', 'bin'), { recursive: true })
  for (const f of ['venv/bin/python3', 'bot_memory.py', 'semantic_search.py']) writeFileSync(join(scripts, f), '')
  return { scripts, memory: '[]' as string | Error, meetings: '[]' }
})
vi.mock('./python-bridge.js', async original => ({ ...(await original<typeof import('./python-bridge.js')>()), COS_SCRIPTS_DIR: fixture.scripts, PYTHON_BIN: join(fixture.scripts, 'venv', 'bin', 'python3') }))
vi.mock('./meeting-ask-search-process.js', async original => ({ ...(await original<typeof import('./meeting-ask-search-process.js')>()),
  runBoundedSearch: vi.fn(async (_bin: string, args: string[]) => {
    if (args[0].endsWith('bot_memory.py')) { if (fixture.memory instanceof Error) throw fixture.memory; return fixture.memory }
    return fixture.meetings
  }) }))
const { searchAskHistory } = await import('./live-cos-ask.js')

afterAll(() => rmSync(fixture.scripts, { recursive: true, force: true }))
beforeEach(() => { fixture.memory = '[]'; fixture.meetings = '[]' })
const signal = () => new AbortController().signal
const NOTE = { id: 'mem_delmar', content: 'Delmar is the pool contractor. He quoted 18500 for the resurfacing and wants a deposit by Friday.', created_at: '2026-10-10T12:00:00+00:00' }
const OTHER = { id: 'mem_swim', content: 'Talia has swim practice on Tuesdays.', created_at: '2026-10-11T12:00:00+00:00' }
const LISTED = 'COS also searched the notes in its memory list by keyword.'

describe('Ask COS search: the memory bridge fallback', () => {
  it('a memory search that answers is used exactly as before and the listing is never read', async () => {
    fixture.memory = JSON.stringify([{ id: 'mem_1', summary: 'Delmar quote', content: 'Delmar quoted the pool', score: 0.9 }])
    const bridge = vi.fn(async () => [NOTE])
    const r = await searchAskHistory('Delmar', undefined, signal(), 'meaning', undefined, bridge)
    expect(bridge).not.toHaveBeenCalled()
    expect(JSON.stringify(r.sources)).toBe(JSON.stringify([{ id: 'H1', kind: 'memory', title: 'Delmar quote', text: 'Delmar quoted the pool', memoryId: 'mem_1' }]))   // 6.76.1 bytes, key order included
    expect(r.notices).toEqual([])
  })
  it('memory search that fails (the public runtime: no bot_memory.py search) reads the listing and cites the matching note', async () => {
    fixture.memory = new Error('memory_parse_error')
    const bridge = vi.fn(async () => [OTHER, NOTE])
    const r = await searchAskHistory('Delmar', 'meeting_live', signal(), 'meaning', undefined, bridge)
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(r.sources).toEqual([{ id: 'H1', kind: 'memory', title: 'Delmar is the pool contractor. He quoted 18500 for the resurfacing and wants a deposit by Friday. · 2026-10-10',
      text: NOTE.content, memoryId: 'mem_delmar' }])
    expect(r.notices).toContain(LISTED)
    expect(r.notices).not.toContain('No relevant COS history was found.')
  })
  it('a meaning search that fails while keyword memory still answers also reads the listing, and both are fused', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const context = mkdtempSync(join(tmpdir(), 'ask-fallback-context-'))
    mkdirSync(join(context, 'memory'))
    writeFileSync(join(context, 'memory', 'delmar.md'), '# Delmar visit\n\nDelmar measured the pool on Monday.\n')
    const prior = process.env.COS_CONTEXT_DIR
    process.env.COS_CONTEXT_DIR = context
    try {
      fixture.memory = new Error('memory_parse_error')
      const bridge = vi.fn(async () => [NOTE])
      const r = await searchAskHistory('Delmar', undefined, signal(), 'meaning', undefined, bridge)
      expect(bridge).toHaveBeenCalledTimes(1)
      expect(r.sources.map(s => s.title)).toEqual(['Delmar visit', expect.stringContaining('Delmar is the pool contractor')])
      fixture.memory = '[]'
      bridge.mockClear()
      const keywordOnly = await searchAskHistory('Delmar', undefined, signal(), 'keyword', undefined, bridge)  // keyword mode answered: no listing
      expect(bridge).not.toHaveBeenCalled()
      expect(keywordOnly.sources.map(s => s.title)).toEqual(['Delmar visit'])
    } finally {
      if (prior === undefined) delete process.env.COS_CONTEXT_DIR; else process.env.COS_CONTEXT_DIR = prior
      rmSync(context, { recursive: true, force: true })
    }
  })
  it('memory search that answers with nothing reads the listing too, in keyword mode as well', async () => {
    const bridge = vi.fn(async () => [NOTE])
    for (const mode of ['meaning', 'keyword'] as const) {
      const r = await searchAskHistory('Delmar', undefined, signal(), mode, undefined, bridge)
      expect(r.sources.map(s => s.memoryId), mode).toEqual(['mem_delmar'])
    }
    expect(bridge).toHaveBeenCalledTimes(2)
  })
  it('nothing in either: the existing empty wording, word for word, and no listing notice', async () => {
    const bridge = vi.fn(async () => [OTHER])
    const r = await searchAskHistory('Delmar', undefined, signal(), 'meaning', undefined, bridge)
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ sources: [], notices: ['No relevant COS history was found.'] })
    const failing = await searchAskHistory('Delmar', undefined, signal(), 'meaning', undefined, async () => { throw new Error('bridge down') })
    expect(failing).toEqual({ sources: [], notices: ['No relevant COS history was found.'] })
  })
  it('a listed note must match as well as any COS hit (0.35), and keeps to a confirmed domain', async () => {
    const half = { id: 'mem_half', content: 'Delmar called.' }                       // shares one of two query words: 0.325
    const both = { id: 'mem_both', content: 'Delmar wants the deposit.', domain: 'personal' }
    const r = await searchAskHistory('Delmar deposit', undefined, signal(), 'meaning', undefined, async () => [half, both])
    expect(r.sources.map(s => s.memoryId)).toEqual(['mem_both'])
    expect((await searchAskHistory('Delmar deposit', undefined, signal(), 'meaning', 'quilt', async () => [half, both])).sources).toEqual([])
    expect((await searchAskHistory('Delmar deposit', undefined, signal(), 'meaning', 'personal', async () => [half, both])).sources.map(s => s.memoryId)).toEqual(['mem_both'])
  })
  it('at most three memory sources, fused with any memory hits by rank', async () => {
    fixture.memory = new Error('memory_parse_error')
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `mem_${i}`, content: `Delmar note ${i}` }))
    const r = await searchAskHistory('Delmar', undefined, signal(), 'meaning', undefined, async () => rows)
    expect(r.sources.map(s => s.id)).toEqual(['H1', 'H2', 'H3'])
    expect(r.sources.map(s => s.memoryId)).toEqual(['mem_0', 'mem_1', 'mem_2'])
  })
  it('an aborted search never reads the listing', async () => {
    const ac = new AbortController(); ac.abort()
    const bridge = vi.fn(async () => [NOTE])
    await searchAskHistory('Delmar', undefined, ac.signal, 'keyword', undefined, bridge)
    expect(bridge).not.toHaveBeenCalled()
  })
})
