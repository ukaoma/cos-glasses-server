/**
 * The build after 7.0.42 (Memories C, Knowledge > Sources): the graph index receipt keeps `doc_count` and `chunk_count`,
 * as MU's lightrag_graph_index.py writes them on every build receipt. They were dropped before.
 */
import { describe, expect, it } from 'vitest'
import { normalizeGraphStatus, normalizeIndexReceipt } from './cos-context-browser.js'

describe('the index receipt counts', () => {
  it('passes doc_count and chunk_count through, on build and on last_run', () => {
    const receipt = { state: 'ok', node_count: 53297, edge_count: 123180, doc_count: 1945, chunk_count: 20412, build_seq: 7 }
    expect(normalizeIndexReceipt(receipt)).toMatchObject({ doc_count: 1945, chunk_count: 20412, node_count: 53297 })
    const status = normalizeGraphStatus({ entities: 53297, relationships: 123180, build: receipt, last_run: { ...receipt, doc_count: 1900 } })
    expect((status.build as Record<string, unknown>).doc_count).toBe(1945)
    expect((status.last_run as Record<string, unknown>).doc_count).toBe(1900)
    expect((status.build as Record<string, unknown>).chunk_count).toBe(20412)
  })

  it('a missing, negative, fractional or text count reads as null', () => {
    for (const bad of [undefined, -1, 2.5, '1945', null]) {
      const out = normalizeIndexReceipt({ doc_count: bad, chunk_count: bad })!
      expect([out.doc_count, out.chunk_count]).toEqual([null, null])
    }
  })
})
