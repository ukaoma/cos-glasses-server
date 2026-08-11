// Release A — SSE contract guard: the /api/query stream's `done` event
// carries attachment REFS only. No base64, no filesystem paths, no storage
// internals may ever enter the stream (they'd also hit the unauth display
// bus via emitDisplay). The model router is mocked; the media store is real
// (temp dir) so refs resolve through the genuine pipeline.
import express from 'express'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MediaStore, _setMediaStoreForTests } from '../lib/media-store.js'
import { isMediaProcessingReady } from '../lib/image-safety.js'
import { currentMessageEra } from '../lib/message-era.js'

// Keep this route contract independent of developer-local server/data state.
// A clean release workspace has no message-era.json and otherwise falls back
// to the legacy era, where a missing era is intentionally accepted.
vi.mock('../lib/message-era.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/message-era.js')>()
  return {
    ...actual,
    currentMessageEra: () => 'era-sse-contract-test',
    currentMessageEraState: () => ({
      v: 1 as const,
      era: 'era-sse-contract-test',
      startedAt: 1,
    }),
  }
})

// Mock ONLY the model router — the query route's own logic stays real.
// Callbacks fire on a macrotask AFTER callModelStreaming resolves, matching
// production (bridge callbacks come from child-process events, never
// synchronously — the route's `const sid = await ...` depends on that).
vi.mock('../lib/model-router.js', () => ({
  callModelStreaming: vi.fn(async (
    query: string,
    sessionId: string | undefined,
    callbacks: { onStart?: (...a: unknown[]) => void; onChunk: (t: string) => void; onDone: (...a: unknown[]) => void },
  ) => {
    const sid = sessionId ?? 'mock-session'
    setTimeout(() => {
      callbacks.onStart?.('opus', sid, undefined, undefined)
      callbacks.onChunk('mock ')
      callbacks.onDone('mock reply text', 'opus', undefined, query === 'with output image' ? {
        outputAttachments: [{
          id: `m_${'b'.repeat(24)}`,
          kind: 'generated_visual',
          mime: 'image/jpeg',
          width: 96,
          height: 64,
          createdAt: '2026-07-11T12:00:00.000Z',
          label: 'Research image',
        }],
      } : undefined)
    }, 10)
    return sid
  }),
}))

import { queryRouter } from './query.js'

let server: Server
let base = ''
let root = ''
let prevStore: MediaStore | null = null
let ffmpegAvailable = false
let attachmentId = ''

/** Read the SSE body until a complete `done` event arrives, then cancel.
 *  Deliberately independent of transport EOF semantics — the contract under
 *  test is the PAYLOAD, not keep-alive teardown. */
async function readSseUntilDone(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 8_000
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now()))),
      ])
      if (result.value) buf += decoder.decode(result.value, { stream: true })
      const doneIdx = buf.indexOf('event: done')
      if (doneIdx >= 0 && buf.indexOf('\n\n', doneIdx) >= 0) break
      if (result.done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return buf
}

beforeAll(async () => {
  ffmpegAvailable = await isMediaProcessingReady()
  root = mkdtempSync(join(tmpdir(), 'cos-sse-test-'))
  const store = new MediaStore(root)
  prevStore = _setMediaStoreForTests(store)
  if (ffmpegAvailable) {
    const jpeg = execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48',
      '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', '-',
    ], { maxBuffer: 8 * 1024 * 1024 })
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    attachmentId = ref.id
  }
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', queryRouter)
  // `resolve` cannot be passed positionally here: listen(port, host, ...) types the
// third argument as backlog, so the void-returning resolve fails every overload.
  // This never surfaced in the app repo because its tsconfig includes only `src`,
  // so the whole forked server/ tree was never type-checked — which is one more
  // reason that tree was not the coverage it appeared to be.
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})

afterAll(async () => {
  _setMediaStoreForTests(prevStore)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

describe('/api/query SSE payload (refs only, never bytes/paths)', () => {
  it('model router is mocked (no real CLI spawns in this suite)', async () => {
    const router = await import('../lib/model-router.js')
    expect(vi.isMockFunction(router.callModelStreaming)).toBe(true)
  })

  it('done event carries attachment refs and zero storage internals', async () => {
    if (!ffmpegAvailable) return
    const res = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'what is this?', attachmentIds: [attachmentId], messageEra: currentMessageEra() }),
    })
    expect(res.status).toBe(200)
    const stream = await readSseUntilDone(res)
    // done event present with the ref
    expect(stream).toContain('event: done')
    const doneLine = stream.split('\n\n').find((b) => b.includes('event: done'))!
    const done = JSON.parse(doneLine.split('data: ')[1])
    expect(done.attachments).toHaveLength(1)
    expect(done.attachments[0].id).toBe(attachmentId)
    expect(Object.keys(done.attachments[0]).sort()).toEqual(
      ['createdAt', 'height', 'id', 'kind', 'mime', 'width'],
    )
    // absolutely no storage internals anywhere in the stream
    expect(stream).not.toContain('storagePath')
    expect(stream).not.toContain('original-normalized')
    expect(stream).not.toContain(root)
    expect(stream).not.toContain('/assets/')
    expect(stream).not.toMatch(/"data"\s*:/)
  }, 15_000)

  it('rejects an unknown attachment id BEFORE opening the stream (typed status)', async () => {
    const res = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x', attachmentIds: ['m_' + 'e'.repeat(24)], messageEra: currentMessageEra() }),
    })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('media_not_found')
  })

  it('text-only queries carry no attachments key in done', async () => {
    const res = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'plain', messageEra: currentMessageEra() }),
    })
    expect(res.status).toBe(200)
    const stream = await readSseUntilDone(res)
    const doneLine = stream.split('\n\n').find((b) => b.includes('event: done'))!
    const done = JSON.parse(doneLine.split('data: ')[1])
    expect('attachments' in done).toBe(false)
  }, 15_000)

  it('merges assistant output refs into the canonical done attachments field', async () => {
    const res = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'with output image', messageEra: currentMessageEra() }),
    })
    expect(res.status).toBe(200)
    const stream = await readSseUntilDone(res)
    const doneLine = stream.split('\n\n').find((b) => b.includes('event: done'))!
    const done = JSON.parse(doneLine.split('data: ')[1])
    expect(done.attachments).toHaveLength(1)
    expect(done.attachments[0]).toMatchObject({
      id: `m_${'b'.repeat(24)}`,
      kind: 'generated_visual',
      label: 'Research image',
    })
    expect('outputAttachments' in done).toBe(false)
    expect(stream).not.toContain('outputAttachments')
  }, 15_000)

  it('rejects a pre-era client before it can contaminate the fresh counter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'legacy client' }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: 'message_era_mismatch',
      era: currentMessageEra(),
    })
    expect(warn).toHaveBeenCalledWith('[query] message era mismatch', expect.objectContaining({
      sentEra: '(missing)',
      expectedEra: currentMessageEra(),
    }))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('legacy client')
    warn.mockRestore()
  })

  it('preserves request refs first and appends distinct output refs', async () => {
    if (!ffmpegAvailable) return
    const res = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'with output image',
        attachmentIds: [attachmentId],
        messageEra: currentMessageEra(),
      }),
    })
    const stream = await readSseUntilDone(res)
    const doneLine = stream.split('\n\n').find((b) => b.includes('event: done'))!
    const done = JSON.parse(doneLine.split('data: ')[1])
    expect(done.attachments.map((ref: { id: string }) => ref.id)).toEqual([
      attachmentId,
      `m_${'b'.repeat(24)}`,
    ])
  }, 15_000)
})
