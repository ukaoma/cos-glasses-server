// The store that makes corrections able to teach anything.
//
// The property that matters most is FIDELITY: an embedding that survives the
// round trip inexactly is worse than none, because it would be enrolled into a
// profile as if it were the speaker's real voice. Every test below writes real
// files and reads them back through the real functions.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let store: typeof import('./chunk-embedding-store.js')

/** A 192-dim vector with awkward values: negatives, tiny magnitudes, and a
 *  value that is not representable exactly in float32 from a JS double. */
function realisticEmbedding(seed = 1): Float32Array {
  return new Float32Array(
    Array.from({ length: 192 }, (_, i) => Math.sin((i + seed) * 0.137) * (i % 7 === 0 ? -0.0031 : 0.41)),
  )
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cos-chunk-emb-'))
  process.env.COS_DATA_DIR = dir
  delete process.env.COS_CHUNK_EMBEDDINGS
  delete process.env.COS_CHUNK_EMBEDDING_TTL_DAYS
  // data-dir resolves DATA_DIR at module scope, so the graph must be rebuilt
  // per test or every test writes into the first test's temp directory.
  const vitest = await import('vitest')
  vitest.vi.resetModules()
  store = await import('./chunk-embedding-store.js')
})
afterEach(() => {
  delete process.env.COS_DATA_DIR
  delete process.env.COS_CHUNK_EMBEDDINGS
  delete process.env.COS_CHUNK_EMBEDDING_TTL_DAYS
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('encoding is exact', () => {
  it('round-trips a 192-dim vector bit for bit', () => {
    const original = realisticEmbedding()
    const decoded = store.decodeEmbedding(store.encodeEmbedding(original))!
    expect(decoded).toHaveLength(192)
    // Bit-exact, not approximate: an averaged profile is only as good as its
    // samples, and a rounded sample is a quietly wrong one.
    for (let i = 0; i < 192; i++) expect(decoded[i]).toBe(original[i])
  })

  it('is more compact than a JSON number array', () => {
    const e = realisticEmbedding()
    expect(store.encodeEmbedding(e).length).toBeLessThan(JSON.stringify(Array.from(e)).length)
  })

  it('rejects garbage rather than returning a wrong-length vector', () => {
    expect(store.decodeEmbedding('')).toBeNull()
    expect(store.decodeEmbedding('AAA')).toBeNull()          // not a multiple of 4 bytes
    expect(store.decodeEmbedding('!!!not base64!!!')).toBeNull()
  })

  it('owns its own memory instead of pinning a Buffer pool slab', () => {
    // A 768-byte base64 decode lands at an offset inside an 8192-byte pool
    // slab. Aliasing it would keep the whole slab alive to hold 768 bytes —
    // ~10x retention across a meeting's worth of embeddings. Asserted on the
    // buffer identity because that is the property that actually differs;
    // Node's pool offset only advances, so the VALUES are never corrupted and
    // a value-comparison test would pass either way and prove nothing.
    const pooled = Buffer.from(store.encodeEmbedding(realisticEmbedding()), 'base64')
    expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength)   // pooling confirmed
    const decoded = store.decodeEmbedding(store.encodeEmbedding(realisticEmbedding()))!
    expect(decoded.byteOffset).toBe(0)
    expect(decoded.buffer.byteLength).toBe(decoded.byteLength)
  })
})

describe('append and read', () => {
  it('persists a chunk and reads it back with its label', () => {
    const e = realisticEmbedding(3)
    expect(store.appendChunkEmbedding('meeting_abc_1', { i: 7, speaker: 'MU', similarity: 0.81, embedding: e })).toBe(true)
    const out = store.readChunkEmbeddings('meeting_abc_1')
    expect(out.missing).toBe(false)
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].i).toBe(7)
    expect(out.rows[0].speaker).toBe('MU')
    expect(out.rows[0].similarity).toBeCloseTo(0.81, 3)
    expect(Array.from(out.rows[0].embedding)).toEqual(Array.from(e))
  })

  it('appends without rewriting, so order and count are preserved', () => {
    for (let i = 0; i < 40; i++) {
      store.appendChunkEmbedding('meeting_abc_2', {
        i, speaker: i % 2 ? 'MU' : 'Clem Ukaoma', similarity: 0.6, embedding: realisticEmbedding(i),
      })
    }
    const out = store.readChunkEmbeddings('meeting_abc_2')
    expect(out.rows).toHaveLength(40)
    expect(out.rows.map(r => r.i)).toEqual([...Array(40).keys()])
  })

  it('distinguishes MISSING from empty — a meeting that predates the store', () => {
    const out = store.readChunkEmbeddings('meeting_never_seen')
    expect(out.missing).toBe(true)
    expect(out.rows).toEqual([])
  })

  it('tolerates a truncated final line and reports it', () => {
    store.appendChunkEmbedding('meeting_abc_3', { i: 0, speaker: 'MU', similarity: 0.7, embedding: realisticEmbedding() })
    const f = join(dir, 'chunk-embeddings', 'meeting_abc_3.jsonl')
    writeFileSync(f, readFileSync(f, 'utf-8') + '{"i":1,"speaker":"MU","v":"AAAB')
    const out = store.readChunkEmbeddings('meeting_abc_3')
    expect(out.rows).toHaveLength(1)      // the good row survives
    expect(out.unusable).toBe(1)          // and the bad one is reported, not hidden
  })

  it('rejects a row that parses but is semantically unusable', () => {
    // Distinct from a truncated line: this is VALID JSON reaching the field
    // checks, which is a different branch and was previously uncovered.
    store.appendChunkEmbedding('meeting_bad', { i: 0, speaker: 'MU', similarity: 0.7, embedding: realisticEmbedding() })
    const f = join(dir, 'chunk-embeddings', 'meeting_bad.jsonl')
    appendFileSync(f, JSON.stringify({ i: 'one', speaker: 'MU', v: store.encodeEmbedding(realisticEmbedding()) }) + '\n')
    appendFileSync(f, JSON.stringify({ i: 1, speaker: 42, v: store.encodeEmbedding(realisticEmbedding()) }) + '\n')
    appendFileSync(f, JSON.stringify({ i: 2, speaker: 'MU', v: null }) + '\n')
    const out = store.readChunkEmbeddings('meeting_bad')
    expect(out.rows).toHaveLength(1)
    expect(out.unusable).toBe(3)
  })

  it('rejects a WRONG-DIMENSION vector rather than averaging it into a profile', () => {
    // This is the dangerous case: a 64-dim vector decodes perfectly cleanly.
    // Nothing downstream would notice, and it would be enrolled as a voice.
    store.appendChunkEmbedding('meeting_dim', { i: 0, speaker: 'MU', similarity: 0.7, embedding: realisticEmbedding() })
    const f = join(dir, 'chunk-embeddings', 'meeting_dim.jsonl')
    appendFileSync(f, JSON.stringify({
      i: 1, speaker: 'MU', v: store.encodeEmbedding(new Float32Array(64).fill(0.5)),
    }) + '\n')
    const out = store.readChunkEmbeddings('meeting_dim')
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].embedding).toHaveLength(store.EXPECTED_EMBEDDING_DIM)
    expect(out.unusable).toBe(1)
  })

  it('refuses a session id that could escape the directory', () => {
    for (const bad of ['../../etc/passwd', 'a/b', '..', '']) {
      expect(store.appendChunkEmbedding(bad, { i: 0, speaker: 'MU', similarity: 0.5, embedding: realisticEmbedding() })).toBe(false)
    }
    expect(existsSync(join(dir, 'chunk-embeddings'))).toBe(false)
  })

  it('never throws from the capture path', () => {
    // A file where the directory belongs makes every write fail. Losing an
    // embedding must never cost a chunk of transcript.
    writeFileSync(join(dir, 'chunk-embeddings'), 'in the way')
    expect(() =>
      store.appendChunkEmbedding('meeting_abc_4', { i: 0, speaker: 'MU', similarity: 0.5, embedding: realisticEmbedding() }),
    ).not.toThrow()
  })
})

describe('selecting the evidence for a correction', () => {
  beforeEach(() => {
    const labels = ['MU', 'Clem Ukaoma', 'Clem Ukaoma', 'Ext', 'MU', 'Clem Ukaoma']
    labels.forEach((speaker, i) =>
      store.appendChunkEmbedding('meeting_sel', { i, speaker, similarity: 0.6, embedding: realisticEmbedding(i) }))
  })

  it('returns every chunk a label claimed', () => {
    expect(store.chunkEmbeddingsForSpeaker('meeting_sel', 'Clem Ukaoma').map(r => r.i)).toEqual([1, 2, 5])
  })

  it('keeps Ext, the case with no other route to training', () => {
    expect(store.chunkEmbeddingsForSpeaker('meeting_sel', 'Ext').map(r => r.i)).toEqual([3])
  })

  it('supports a PARTIAL correction by explicit indices', () => {
    // Only some of a voice's segments are usually wrong; correcting all of them
    // would be the same over-reach as a whole-profile merge.
    expect(store.chunkEmbeddingsForIndices('meeting_sel', [1, 5]).map(r => r.i)).toEqual([1, 5])
    expect(store.chunkEmbeddingsForIndices('meeting_sel', [99])).toEqual([])
  })
})

describe('retention', () => {
  function seedSession(id: string, ageDays: number): void {
    store.appendChunkEmbedding(id, { i: 0, speaker: 'MU', similarity: 0.7, embedding: realisticEmbedding() })
    const f = join(dir, 'chunk-embeddings', `${id}.jsonl`)
    const t = (Date.now() - ageDays * 86_400_000) / 1000
    utimesSync(f, t, t)
  }

  it('sweeps past the window and keeps what is inside it', () => {
    seedSession('meeting_old', 20)
    seedSession('meeting_fresh', 1)
    const out = store.sweepExpiredChunkEmbeddings(Date.now())
    expect(out.removed).toEqual(['meeting_old.jsonl'])
    expect(out.retained).toEqual(['meeting_fresh.jsonl'])
    expect(store.readChunkEmbeddings('meeting_old').missing).toBe(true)
    expect(store.readChunkEmbeddings('meeting_fresh').rows).toHaveLength(1)
  })

  it('defaults to 14 days, long enough to survive a weekend', () => {
    // An 8-hour window would make a Friday meeting uncorrectable by Monday,
    // which is the modal case rather than an edge one.
    expect(store.chunkEmbeddingTtlMs()).toBe(14 * 86_400_000)
  })

  it('honours the env override', async () => {
    process.env.COS_CHUNK_EMBEDDING_TTL_DAYS = '0.25'
    const vitest = await import('vitest')
    vitest.vi.resetModules()
    const s2 = await import('./chunk-embedding-store.js')
    expect(s2.chunkEmbeddingTtlMs()).toBe(0.25 * 86_400_000)
  })

  it('ignores a nonsense override rather than deleting everything', async () => {
    for (const bad of ['0', '-5', 'soon', '']) {
      process.env.COS_CHUNK_EMBEDDING_TTL_DAYS = bad
      const vitest = await import('vitest')
      vitest.vi.resetModules()
      const s2 = await import('./chunk-embedding-store.js')
      expect(s2.chunkEmbeddingTtlMs(), bad).toBe(14 * 86_400_000)
    }
  })

  it('RETAINS a file whose mtime cannot be read', () => {
    // A dangling symlink makes statSync throw for real. Treating that as
    // "ancient" would delete the evidence a pending correction depends on.
    seedSession('meeting_keep', 1)
    symlinkSync(join(dir, 'nowhere'), join(dir, 'chunk-embeddings', 'meeting_broken.jsonl'))
    const out = store.sweepExpiredChunkEmbeddings(Date.now())
    expect(out.removed).toEqual([])
    expect(out.retained.sort()).toEqual(['meeting_broken.jsonl', 'meeting_keep.jsonl'])
    // lstat, not existsSync: existsSync follows the link and a dangling link
    // reads as absent even though the link itself was correctly left alone.
    expect(lstatSync(join(dir, 'chunk-embeddings', 'meeting_broken.jsonl')).isSymbolicLink()).toBe(true)
  })

  it('is a no-op when the directory does not exist', () => {
    expect(store.sweepExpiredChunkEmbeddings(Date.now())).toEqual({ removed: [], retained: [] })
  })
})

describe('the master switch', () => {
  it('writes nothing when disabled', async () => {
    process.env.COS_CHUNK_EMBEDDINGS = '0'
    const vitest = await import('vitest')
    vitest.vi.resetModules()
    const s2 = await import('./chunk-embedding-store.js')
    expect(s2.chunkEmbeddingsEnabled()).toBe(false)
    expect(s2.appendChunkEmbedding('meeting_off', { i: 0, speaker: 'MU', similarity: 0.5, embedding: realisticEmbedding() })).toBe(false)
    expect(existsSync(join(dir, 'chunk-embeddings'))).toBe(false)
  })

  it('is ON by default — without it a correction can never train', () => {
    expect(store.chunkEmbeddingsEnabled()).toBe(true)
  })
})

describe('health stats', () => {
  it('reports sessions, bytes, and the oldest age', () => {
    store.appendChunkEmbedding('meeting_s1', { i: 0, speaker: 'MU', similarity: 0.7, embedding: realisticEmbedding() })
    store.appendChunkEmbedding('meeting_s2', { i: 0, speaker: 'MU', similarity: 0.7, embedding: realisticEmbedding() })
    const st = store.chunkEmbeddingStoreStats()
    expect(st.enabled).toBe(true)
    expect(st.sessions).toBe(2)
    expect(st.bytes).toBeGreaterThan(2000)
    expect(st.ttlDays).toBe(14)
    expect(st.oldestAgeHours).not.toBeNull()
  })

  it('reports an empty store without inventing an age', () => {
    const st = store.chunkEmbeddingStoreStats()
    expect(st.sessions).toBe(0)
    expect(st.oldestAgeHours).toBeNull()
  })
})

describe('size, measured rather than assumed', () => {
  it('a 400-chunk meeting stays under a megabyte', () => {
    for (let i = 0; i < 400; i++) {
      store.appendChunkEmbedding('meeting_big', { i, speaker: 'MU', similarity: 0.7, embedding: realisticEmbedding(i) })
    }
    const bytes = store.chunkEmbeddingStoreStats().bytes
    expect(bytes).toBeGreaterThan(300_000)
    expect(bytes).toBeLessThan(1_000_000)
  })
})
