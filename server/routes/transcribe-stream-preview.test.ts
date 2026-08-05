import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let server: Server | null = null
let transcribeMeetingPreview: ReturnType<typeof vi.fn>

async function post(path: string, body: Buffer, headers: Record<string, string> = {}) {
  const address = server?.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        ...headers,
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cos-meeting-preview-'))
  process.env.COS_DATA_DIR = root
  process.env.COS_WHISPER_MEETING_PREVIEW = '1'
  vi.resetModules()
  transcribeMeetingPreview = vi.fn(async () => ({
    text: 'fast preview words',
    model: 'large-v3-turbo',
    backend: 'whisper-preview-server',
  }))
  vi.doMock('../lib/whisper-preview.js', () => ({
    transcribeWhisperMeetingPreview: transcribeMeetingPreview,
  }))
  vi.doMock('../lib/server-instance-id.js', () => ({ getServerInstanceId: () => 'server-a' }))
  const stream = await import('./transcribe-stream.js')
  const app = express()
  app.use('/api', stream.transcribeStreamRouter)
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
})

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  delete process.env.COS_DATA_DIR
  delete process.env.COS_WHISPER_MEETING_PREVIEW
  vi.resetModules()
  vi.doUnmock('../lib/whisper-preview.js')
  vi.doUnmock('../lib/server-instance-id.js')
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('meeting Turbo preview route', () => {
  const path = '/api/transcribe-stream/preview?sessionId=meeting_preview_1&chunkIndex=0&previewGen=3&serverInstanceId=server-a'
  const pin = { 'X-COS-Server-Instance': 'server-a' }

  it('returns pinned provisional Turbo text without creating meeting state', async () => {
    const response = await post(path, Buffer.alloc(12_800, 1), pin)
    expect(response.status).toBe(200)
    expect(response.json).toEqual({
      sessionId: 'meeting_preview_1',
      chunkIndex: 0,
      previewGen: 3,
      text: 'fast preview words',
      provisional: true,
      model: 'large-v3-turbo',
      backend: 'whisper-preview-server',
      serverInstanceId: 'server-a',
    })
    expect(transcribeMeetingPreview).toHaveBeenCalledTimes(1)
    const stream = await import('./transcribe-stream.js')
    expect(stream.getMeetingSessionStatus('meeting_preview_1')).toMatchObject({ state: 'missing' })
  })

  it('fails before inference on a wrong or missing server pin', async () => {
    const wrong = await post(
      path.replaceAll('server-a', 'server-b'),
      Buffer.alloc(1_000, 1),
      { 'X-COS-Server-Instance': 'server-b' },
    )
    expect(wrong.status).toBe(409)
    const missing = await post(
      '/api/transcribe-stream/preview?sessionId=meeting_preview_1&chunkIndex=0&previewGen=3',
      Buffer.alloc(1_000, 1),
    )
    expect(missing.status).toBe(400)
    expect(transcribeMeetingPreview).not.toHaveBeenCalled()
  })

  it('bounds the copied preview body and keeps the canonical lane untouched', async () => {
    const response = await post(path, Buffer.alloc(512 * 1024 + 1, 1), pin)
    expect(response.status).toBe(413)
    expect(response.json).toMatchObject({ reason: 'chunk_too_large' })
    expect(transcribeMeetingPreview).not.toHaveBeenCalled()
  })

  it('drops cosmetically when the server kill switch is off', async () => {
    process.env.COS_WHISPER_MEETING_PREVIEW = '0'
    const response = await post(path, Buffer.alloc(1_000, 1), pin)
    expect(response.status).toBe(204)
    expect(transcribeMeetingPreview).not.toHaveBeenCalled()
  })
})
