// Diagnostics over the per-chunk embedding store.
//
// These run the real scoring against a real store on disk. The thing worth
// protecting is not the arithmetic — it is that a caller can always tell three
// different situations apart:
//
//   nothing retained   (aged out, or captured before 6.21.15)
//   retained but the asked-for chunk is absent
//   retained and scored
//
// Collapsing any two of those is how "no data" gets read as "no match", which
// is the same absence-inference failure that has bitten this codebase before.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dataDir = ''

/** A deterministic unit-length-ish vector, distinct per seed. */
function embedding(seed: number, dim = 192): Float32Array {
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = Math.sin((i + 1) * (seed + 1) * 0.017)
  return out
}

/**
 * Seed the profile store on disk.
 *
 * NOT via `enrollEmbedding`: without the ONNX extractor initialised it returns
 * `{success:false, error:'Speaker embeddings not initialized'}` and enrolls
 * nothing. An earlier draft of this file used it, asserted nothing about the
 * result, and every "top match" assertion passed against an EMPTY profile list
 * — a vacuous test that looked like coverage.
 */
function seedProfiles(profiles: Array<{ name: string; seeds: number[] }>): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({
    profiles: profiles.map(p => ({
      name: p.name,
      embeddings: p.seeds.map(seed => Array.from(embedding(seed))),
      sources: p.seeds.map(() => 'manual'),
    })),
  }, null, 2))
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'chunk-diag-'))
  process.env.COS_DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(() => {
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
})

describe('chunkDiagnostics', () => {
  it('reports retained:false when the store holds nothing for the session', async () => {
    const { chunkDiagnostics } = await import('./chunk-embedding-diagnostics.js')

    const result = chunkDiagnostics('meeting_absent_xyz')

    // Must be distinguishable from "scored and found nothing".
    expect(result.retained).toBe(false)
    expect(result.chunks).toEqual([])
    expect(result.sessionId).toBe('meeting_absent_xyz')
  })

  it('reports retained:false for named chunks too, not just a whole-session read', async () => {
    // `chunkDiagnostics` computes `retained` on two separate branches, and only
    // the whole-session one was covered — a mutation hardcoding `retained: true`
    // on the indices branch passed the entire suite. That branch is the one the
    // review panel actually calls, and reading "no data" as "scored, no match"
    // is exactly the absence-inference failure this file exists to prevent.
    seedProfiles([{ name: 'A', seeds: [1] }])
    const { chunkDiagnostics } = await import('./chunk-embedding-diagnostics.js')

    const result = chunkDiagnostics('meeting_absent_indices', [1, 2, 3])

    expect(result.retained).toBe(false)
    expect(result.chunks).toEqual([])
    expect(result.missing).toEqual([1, 2, 3])
  })

  it('scores a retained chunk against the enrolled profiles', async () => {
    seedProfiles([{ name: 'Queen Ukaoma', seeds: [1] }, { name: 'Clem Ukaoma', seeds: [9] }])
    const store = await import('./chunk-embedding-store.js')

    const session = 'meeting_scored_1'
    store.appendChunkEmbedding(session, { i: 4, speaker: 'Ext', similarity: 0.42, embedding: embedding(1) })

    const { chunkDiagnostics } = await import('./chunk-embedding-diagnostics.js')
    const result = chunkDiagnostics(session, [4])

    // Setup gate: if the profile store were empty this whole test would pass
    // vacuously, which is exactly how the first draft was wrong.
    expect(result.profileCount).toBe(2)
    expect(result.retained).toBe(true)
    expect(result.chunks).toHaveLength(1)
    const chunk = result.chunks[0]
    expect(chunk.chunk).toBe(4)
    // The label chosen LIVE is preserved — that is what a correction corrects.
    expect(chunk.chosen).toBe('Ext')
    expect(chunk.chosenSimilarity).toBeCloseTo(0.42, 3)
    // Scored against the current store: the identical vector is the top match.
    expect(chunk.matches[0].speaker).toBe('Queen Ukaoma')
    expect(chunk.matches[0].similarity).toBeGreaterThan(0.99)
    expect(chunk.matches[0].embeddings).toBeGreaterThan(0)
  })

  it('reports a margin, which is what separates a near-miss from an ambiguous voice', async () => {
    seedProfiles([{ name: 'A', seeds: [1] }, { name: 'B', seeds: [40] }])
    const store = await import('./chunk-embedding-store.js')

    const session = 'meeting_margin_1'
    store.appendChunkEmbedding(session, { i: 0, speaker: 'A', similarity: 0.7, embedding: embedding(1) })

    const { chunkDiagnostics } = await import('./chunk-embedding-diagnostics.js')
    const chunk = chunkDiagnostics(session, [0]).chunks[0]

    expect(chunk.margin).not.toBeNull()
    expect(chunk.margin!).toBeCloseTo(chunk.matches[0].similarity - chunk.matches[1].similarity, 4)
  })

  it('lists chunks it does not hold instead of silently dropping them', async () => {
    seedProfiles([{ name: 'A', seeds: [1] }])
    const store = await import('./chunk-embedding-store.js')

    const session = 'meeting_missing_1'
    store.appendChunkEmbedding(session, { i: 2, speaker: 'A', similarity: 0.8, embedding: embedding(1) })

    const { chunkDiagnostics } = await import('./chunk-embedding-diagnostics.js')
    const result = chunkDiagnostics(session, [2, 77, 91])

    // Retained IS true here — the session has data, these chunks just are not
    // in it. Reporting that as retained:false would be a lie about the store.
    expect(result.retained).toBe(true)
    expect(result.chunks.map(c => c.chunk)).toEqual([2])
    expect(result.missing).toEqual([77, 91])
  })

  it('caps a whole-session read, because every chunk is scored against every profile', async () => {
    seedProfiles([{ name: 'A', seeds: [1] }])
    const store = await import('./chunk-embedding-store.js')

    const session = 'meeting_capped_1'
    for (let i = 0; i < 30; i++) {
      store.appendChunkEmbedding(session, { i, speaker: 'A', similarity: 0.8, embedding: embedding(i) })
    }

    const { chunkDiagnostics } = await import('./chunk-embedding-diagnostics.js')
    expect(chunkDiagnostics(session, [], 10).chunks).toHaveLength(10)
    expect(chunkDiagnostics(session, [], 100).chunks).toHaveLength(30)
  })

  it('never returns raw embedding vectors', async () => {
    // 192 floats per chunk is ~1 KB of base64 that means nothing to a reader,
    // and a long meeting would be hundreds of KB of it. Similarity is the
    // diagnostic; the vector is only how it is computed.
    seedProfiles([{ name: 'A', seeds: [1] }])
    const store = await import('./chunk-embedding-store.js')

    const session = 'meeting_novec_1'
    store.appendChunkEmbedding(session, { i: 0, speaker: 'A', similarity: 0.8, embedding: embedding(1) })

    const { chunkDiagnostics } = await import('./chunk-embedding-diagnostics.js')
    const serialized = JSON.stringify(chunkDiagnostics(session, [0]))

    expect(serialized).not.toContain('embedding"')
    expect(Object.keys(chunkDiagnostics(session, [0]).chunks[0])).not.toContain('embedding')
  })
})
