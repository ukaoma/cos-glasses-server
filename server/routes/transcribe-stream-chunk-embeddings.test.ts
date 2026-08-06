// Does a real chunk upload actually bank its voiceprint?
//
// The store itself is unit-tested. This file tests the WIRE-UP, because a
// perfect store that is never called is worth exactly zero — and a source-shape
// grep for `appendChunkEmbedding(` would pass while the call sat behind a
// condition that is never true. So these drive the real express route with a
// real POST and assert the file that lands on disk.
import express from 'express'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let root = ''
let server: Server | null = null

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.doUnmock('../lib/whisper-local.js')
  vi.doUnmock('../lib/audio-enhance.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  vi.doUnmock('../lib/vad-silero.js')
  vi.doUnmock('../lib/profile.js')
  delete process.env.COS_DATA_DIR
  delete process.env.COS_CHUNK_EMBEDDINGS
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A distinctive vector, so a row read back can be proved to be THIS chunk's. */
function fingerprint(seed: number): Float32Array {
  return new Float32Array(Array.from({ length: 192 }, (_, i) => (i === 0 ? seed : Math.cos(i * seed) * 0.3)))
}

async function mountRoute(opts: {
  identify: (...args: unknown[]) => unknown
}): Promise<{ base: string; stream: typeof import('./transcribe-stream.js') }> {
  vi.resetModules()
  vi.doMock('../lib/whisper-local.js', () => ({
    transcribeLocal: vi.fn().mockResolvedValue({ text: 'hello there', words: [], backend: 'mock' }),
    applyCorrections: (text: string) => text,
  }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    identifySpeaker: opts.identify,
    isEmbeddingAvailable: () => true,
    // Must return the real shape: the route reads .enrolled off it.
    autoEnroll: vi.fn().mockReturnValue({ enrolled: false, reason: 'test' }),
    getEmbeddingCount: () => 3,
  }))
  vi.doMock('../lib/vad-silero.js', () => ({ trimSilence: vi.fn(), isSileroAvailable: () => false }))
  vi.doMock('../lib/profile.js', () => ({
    getVocabulary: () => [],
    getOwnerName: () => 'COS',
    getWhisperCorrections: () => '',
    getOwnerSpeakerLabel: () => 'MU',
  }))

  const stream = await import('./transcribe-stream.js')
  const app = express()
  app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  return {
    base: typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '',
    stream,
  }
}

async function postChunk(base: string, sessionId: string, chunkIndex: number, speaker = 'MU'): Promise<number> {
  // MUST exceed 2s: identifyChunkSpeaker early-returns below that threshold and
  // never identifies at all. A 1s buffer makes every assertion here pass
  // vacuously — including the "writes nothing" ones, which is how a too-short
  // fixture turns a broken wire-up into a green suite.
  const audio = Buffer.alloc(44 + 3 * 32_000, 1)   // 44-byte WAV header + 3s @ 16 kHz mono
  return new Promise<number>((resolve, reject) => {
    const req = request(
      `${base}/api/transcribe-stream?sessionId=${sessionId}&chunkIndex=${chunkIndex}&speaker=${speaker}`,
      {
        method: 'POST',
        headers: { 'Content-Length': String(audio.length), 'Content-Type': 'application/octet-stream' },
      },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) },
    )
    req.on('error', reject)
    req.end(audio)
  })
}

function storedRows(sessionId: string): Array<Record<string, unknown>> {
  const path = join(root, 'chunk-embeddings', `${sessionId}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('a chunk upload banks its voiceprint', () => {
  it('persists the embedding the identifier actually used', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-chunk-emb-wire-'))
    process.env.COS_DATA_DIR = root
    const embedding = fingerprint(7)
    const { base, stream } = await mountRoute({
      identify: vi.fn().mockReturnValue({ speaker: 'Clem Ukaoma', similarity: 0.72, embedding }),
    })

    expect(await postChunk(base, 'wire_001', 0)).toBe(200)

    const rows = storedRows('wire_001')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ i: 0, speaker: 'Clem Ukaoma', similarity: 0.72, dim: 192 })
    // Prove it is THIS chunk's vector, not a placeholder. Decoded through the
    // store's own reader: a hand-rolled `Buffer.from(v).buffer.slice(0)` reads
    // from the POOL SLAB's start, not the embedding's byteOffset, and silently
    // returns a neighbouring allocation's bytes.
    const { decodeEmbedding } = await import('../lib/chunk-embedding-store.js')
    const decoded = decodeEmbedding(String(rows[0].v))!
    expect(decoded).toHaveLength(192)
    expect(decoded[0]).toBeCloseTo(7, 5)
    expect(Array.from(decoded)).toEqual(Array.from(embedding))
    stream.deleteSession('wire_001')
  })

  it('stores the chunk index the client sent, so a correction can name segments', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-chunk-emb-idx-'))
    process.env.COS_DATA_DIR = root
    const { base, stream } = await mountRoute({
      identify: vi.fn().mockImplementation(() => ({ speaker: 'MU', similarity: 0.9, embedding: fingerprint(1) })),
    })

    for (const i of [0, 1, 2]) expect(await postChunk(base, 'wire_idx', i)).toBe(200)

    // The index is the only join key to the sidecar. If it were derived from a
    // counter instead of the request, a retried or out-of-order chunk would
    // point a correction at the wrong segment.
    expect(storedRows('wire_idx').map(r => r.i)).toEqual([0, 1, 2])
    stream.deleteSession('wire_idx')
  })

  it('records Ext, whose only route to a name IS a correction', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-chunk-emb-ext-'))
    process.env.COS_DATA_DIR = root
    const { base, stream } = await mountRoute({
      identify: vi.fn().mockReturnValue({ speaker: 'Ext', similarity: 0, embedding: fingerprint(3) }),
    })

    expect(await postChunk(base, 'wire_ext', 0)).toBe(200)

    expect(storedRows('wire_ext')).toHaveLength(1)
    expect(storedRows('wire_ext')[0]).toMatchObject({ speaker: 'Ext' })
    stream.deleteSession('wire_ext')
  })

  it('writes nothing when identification produced no embedding', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-chunk-emb-none-'))
    process.env.COS_DATA_DIR = root
    const { base, stream } = await mountRoute({ identify: vi.fn().mockReturnValue(null) })

    expect(await postChunk(base, 'wire_none', 0)).toBe(200)

    expect(storedRows('wire_none')).toEqual([])
    stream.deleteSession('wire_none')
  })

  it('still transcribes when the embedding store is switched off', async () => {
    // The capture path must never depend on this feature succeeding.
    root = mkdtempSync(join(tmpdir(), 'cos-chunk-emb-off-'))
    process.env.COS_DATA_DIR = root
    process.env.COS_CHUNK_EMBEDDINGS = '0'
    const { base, stream } = await mountRoute({
      identify: vi.fn().mockReturnValue({ speaker: 'MU', similarity: 0.8, embedding: fingerprint(2) }),
    })

    expect(await postChunk(base, 'wire_off', 0)).toBe(200)

    expect(existsSync(join(root, 'chunk-embeddings'))).toBe(false)
    expect(stream.getMeetingSessionStatus('wire_off')).toMatchObject({ receivedCount: 1 })
    stream.deleteSession('wire_off')
  })
})
