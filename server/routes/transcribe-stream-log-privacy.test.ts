// 6.85.0: the per-chunk [perf] TOTAL line carries timing and a character count, never the
// meeting text. It used to end with the first 50 characters of every chunk's transcript.
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SPOKEN = 'Priya said the Lakeview renewal closes on Thursday at noon'

let root = ''
let server: Server | null = null

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('../lib/whisper-local.js')
  vi.doUnmock('../lib/audio-enhance.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  vi.doUnmock('../lib/vad-silero.js')
  vi.doUnmock('../lib/profile.js')
  delete process.env.COS_DATA_DIR
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

async function mountRoute(): Promise<{ base: string; stream: typeof import('./transcribe-stream.js') }> {
  vi.resetModules()
  vi.doMock('../lib/whisper-local.js', () => ({
    transcribeLocal: vi.fn().mockResolvedValue({ text: SPOKEN, words: [], backend: 'mock' }),
    applyCorrections: (text: string) => text,
  }))
  vi.doMock('../lib/audio-enhance.js', () => ({ enhanceAudio: async (audio: Buffer) => audio }))
  vi.doMock('../lib/speaker-embeddings.js', () => ({
    AUTO_ENROLL_CANDIDATE_SIMILARITY: 0.72, AUTO_ENROLL_THRESHOLD: 0.88,
    identifySpeaker: vi.fn().mockReturnValue({ speaker: 'MU', similarity: 0.9, embedding: new Float32Array(192) }),
    isEmbeddingAvailable: () => true,
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
  return { base: typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '', stream }
}

function postChunk(base: string, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const audio = Buffer.alloc(44 + 3 * 32_000, 1)
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}/api/transcribe-stream?${query}`,
      { method: 'POST', headers: { 'Content-Length': String(audio.length), 'Content-Type': 'application/octet-stream' } },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: Record<string, unknown> = {}
          try { body = JSON.parse(raw) as Record<string, unknown> } catch { body = { raw } }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end(audio)
  })
}

describe('the server log never carries meeting text (6.85.0)', () => {
  it('[perf] TOTAL keeps its timing fields and a character count, not the transcript', async () => {
    root = mkdtempSync(join(tmpdir(), 'cos-log-privacy-'))
    process.env.COS_DATA_DIR = root
    const lines: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(arg => typeof arg === 'string' ? arg : String(arg)).join(' '))
      })
    }
    const { base, stream } = await mountRoute()

    const res = await postChunk(base, 'sessionId=privacy_001&chunkIndex=0&speaker=MU')
    expect(res.status).toBe(200)
    // The chunk really carried the text, so the log line had it to leak.
    expect(res.body.text).toBe(SPOKEN)

    const total = lines.filter(line => line.includes('[perf] TOTAL request:'))
    expect(total).toHaveLength(1)
    expect(total[0]).toMatch(/TOTAL request: \d+(\.\d)?ms \| chunk #0 \| \d+b \| rms=\d+ q=[01] gate=/)
    expect(total[0]).toContain(`chars=${SPOKEN.length}`)
    for (const word of ['Priya', 'Lakeview', 'renewal', 'Thursday']) {
      expect(total[0]).not.toContain(word)
    }
    // No other line written while the chunk ran carries it either.
    expect(lines.filter(line => line.includes('Lakeview'))).toEqual([])
    stream.deleteSession('privacy_001')
  })
})
