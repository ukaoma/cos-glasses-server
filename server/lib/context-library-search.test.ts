import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  keywordHitsFromRecords,
  keywordHitsFromThreadCache,
  memorySemanticArgs,
  memorySemanticAvailable,
  mergeContextSearchHits,
  threadSemanticAvailable,
  type ContextSearchHit,
} from './context-library-search.js'
import { tokenizeMeetingQuery } from './meeting-library-search.js'

const envKeys = ['COS_CONTEXT_DIR', 'COS_SCRIPTS_DIR', 'COS_OPERATIONS_DIR'] as const
const previous: Partial<Record<typeof envKeys[number], string | undefined>> = {}

afterEach(() => {
  for (const key of envKeys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    delete previous[key]
  }
})

function hit(partial: Partial<ContextSearchHit> & Pick<ContextSearchHit, 'id' | 'title'>): ContextSearchHit {
  return {
    snippet: '',
    kind: 'memory',
    keywordScore: 0,
    semanticScore: 0,
    match: 'keyword',
    ...partial,
  }
}

describe('context library search helpers', () => {
  it('reuses meeting tokenize/stopwords', () => {
    expect(tokenizeMeetingQuery('the Toast in grocery')).toEqual(['toast', 'grocery'])
  })

  it('scores keyword records and drops empty ids', () => {
    const tokens = tokenizeMeetingQuery('toast grocery')
    const hits = keywordHitsFromRecords(tokens, [
      { id: 'file_a.md', title: 'Countering Toast In Grocery', haystack: 'notes' },
      { id: '', title: 'Toast', haystack: 'toast grocery' },
      { id: 'file_b.md', title: 'Staffing', haystack: 'unrelated' },
    ], 'memory')
    expect(hits.map(row => row.id)).toEqual(['file_a.md'])
    expect(hits[0].match).toBe('keyword')
  })

  it('reports memories semantic unavailable without embeddings and never names the meeting script', () => {
    expect(memorySemanticAvailable(null, null)).toEqual({ ok: false, reason: 'no_memory_embeddings' })
    const args = memorySemanticArgs('toast', 8)
    expect(args[0]).toBe('bot_memory.py')
    expect(args).toContain('search')
    expect(args.join(' ')).not.toContain('semantic_search.py')
  })

  it('threads have no embedding index', () => {
    expect(threadSemanticAvailable()).toEqual({ ok: false, reason: 'no_thread_embeddings' })
  })

  it('merges keyword and meaning hits for the same memory id', () => {
    const merged = mergeContextSearchHits(
      [hit({ id: 'mem_1', title: 'Toast', keywordScore: 0.8, snippet: 'keyword' })],
      [hit({ id: 'mem_1', title: 'Toast', semanticScore: 0.6, match: 'semantic', snippet: 'meaning' })],
      10,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].match).toBe('both')
    expect(merged[0].snippet).toBe('keyword')
  })

  it('keyword-scans thread cache JSON without touching meeting Qdrant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-thread-search-'))
    previous.COS_SCRIPTS_DIR = process.env.COS_SCRIPTS_DIR
    process.env.COS_SCRIPTS_DIR = dir
    writeFileSync(join(dir, '.threads_cache.json'), JSON.stringify({
      threads: [{ id: '7ce8073d', name: 'Hubspot Theme Settings', topics: ['theme'], meetings: [{ name: 'Tune-Up' }] }],
    }))
    const tokens = tokenizeMeetingQuery('hubspot theme')
    const hits = keywordHitsFromThreadCache(tokens, dir)
    expect(hits.map(row => row.id)).toEqual(['7ce8073d'])
    expect(hits[0].kind).toBe('thread')
  })
})
