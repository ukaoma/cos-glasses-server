// Integration test for the media API through the REAL middleware order used
// by server/index.ts: route-scoped 16 MB parser → global 10 MB express.json →
// /api auth → routes. Proves a maximum valid batch clears the pipeline and
// that auth/limits/typed errors behave end-to-end.
import express from 'express'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mediaBodyParser, mediaRouter } from './media.js'
import { MediaStore, _setMediaStoreForTests } from '../lib/media-store.js'
import { isMediaProcessingReady, MAX_BATCH_BYTES } from '../lib/image-safety.js'

const TOKEN = 'test-token-media'
let server: Server | null = null
let base = ''
let root = ''
let prevStore: MediaStore | null = null
let ffmpegAvailable = false
let jpegB64 = ''
let bigJpegB64 = ''

function buildApp() {
  const app = express()
  // EXACT order from server/index.ts
  app.use('/api/media', mediaBodyParser)
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  })
  app.use('/api', mediaRouter)
  return app
}

async function api(path: string, opts: RequestInit = {}, auth = true): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { 'x-cos-token': TOKEN } : {}),
      ...(opts.headers ?? {}),
    },
  })
}

beforeAll(async () => {
  ffmpegAvailable = await isMediaProcessingReady()
  root = mkdtempSync(join(tmpdir(), 'cos-media-route-'))
  prevStore = _setMediaStoreForTests(new MediaStore(root))
  if (ffmpegAvailable) {
    jpegB64 = execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=200x150',
      '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', '-',
    ], { maxBuffer: 8 * 1024 * 1024 }).toString('base64')
    // ~1.6 MiB decoded per image so a 5-image batch sits just under the
    // 8 MiB decoded ceiling while its base64 exceeds the global 10 MB JSON
    // cap. Built by concatenating a valid JPEG into a multi-frame MJPEG
    // stream — frame 1 stays fully decodable, the tail is legal padding.
    const single = Buffer.from(jpegB64, 'base64')
    const target = 1_640_000
    const copies = Math.ceil(target / single.length)
    bigJpegB64 = Buffer.concat(Array.from({ length: copies }, () => single))
      .subarray(0, target).toString('base64')
  }
  await new Promise<void>((resolve) => {
    server = buildApp().listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server!.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})

afterAll(async () => {
  _setMediaStoreForTests(prevStore)
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  rmSync(root, { recursive: true, force: true })
})

describe('media API (real middleware order)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await api('/api/media', { method: 'POST', body: '{}' }, false)
    expect(res.status).toBe(401)
  })

  it('uploads a JPEG and serves metadata + content with safe headers', async () => {
    if (!ffmpegAvailable) return
    const res = await api('/api/media', {
      method: 'POST',
      body: JSON.stringify({ images: [{ data: jpegB64, label: 'route test' }] }),
    })
    expect(res.status).toBe(200)
    const { attachments } = await res.json() as { attachments: Array<{ id: string; mime: string }> }
    expect(attachments).toHaveLength(1)
    const id = attachments[0].id
    expect(id).toMatch(/^m_[a-f0-9]{24}$/)

    const meta = await api(`/api/media/${id}`)
    expect(meta.status).toBe(200)
    const metaBody = await meta.json() as { attachment: { id: string }; contentAvailable: boolean }
    expect(metaBody.attachment.id).toBe(id)
    expect(metaBody.contentAvailable).toBe(true)

    for (const variant of ['phone', 'thumb'] as const) {
      const content = await api(`/api/media/${id}/content?variant=${variant}`)
      expect(content.status).toBe(200)
      expect(content.headers.get('content-type')).toBe('image/jpeg')
      expect(content.headers.get('cache-control')).toBe('private, no-store')
      expect(content.headers.get('x-content-type-options')).toBe('nosniff')
      expect(Number(content.headers.get('content-length'))).toBeGreaterThan(0)
      const bytes = Buffer.from(await content.arrayBuffer())
      expect(bytes[0]).toBe(0xff) // JPEG magic
      expect(bytes.length).toBe(Number(content.headers.get('content-length')))
    }
  })

  it('accepts a maximum valid batch through the real parser stack (>10MB encoded)', async () => {
    if (!ffmpegAvailable) return
    const decodedBytes = Buffer.from(bigJpegB64, 'base64').length
    const count = Math.min(5, Math.floor(MAX_BATCH_BYTES / decodedBytes))
    expect(count).toBeGreaterThanOrEqual(4)
    const body = JSON.stringify({ images: Array.from({ length: count }, () => ({ data: bigJpegB64 })) })
    // The point of the scoped parser: this payload exceeds the global 10 MB cap.
    expect(body.length).toBeGreaterThan(10 * 1024 * 1024)
    const res = await api('/api/media', { method: 'POST', body })
    expect(res.status).toBe(200)
    const { attachments } = await res.json() as { attachments: unknown[] }
    expect(attachments).toHaveLength(count)
  }, 60_000)

  it('rejects malformed base64, wrong formats, oversized batches, and >5 images', async () => {
    if (!ffmpegAvailable) return
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ images: [{ data: '!!not-base64!!' }] }, 400, 'invalid_base64'],
      [{ images: [{ data: Buffer.from('<svg/>').toString('base64') }] }, 400, 'unsupported_format'],
      [{ images: [{ data: Buffer.from('%PDF-1.4 junk').toString('base64') }] }, 400, 'unsupported_format'],
      [{ images: Array.from({ length: 6 }, () => ({ data: jpegB64 })) }, 400, 'too_many_images'],
      [{ images: [] }, 400, 'no_images'],
      [{ images: [{ data: jpegB64 }], kind: 'generated_visual' }, 400, 'unsupported_kind'],
    ]
    for (const [body, status, code] of cases) {
      const res = await api('/api/media', { method: 'POST', body: JSON.stringify(body) })
      expect(res.status, code).toBe(status)
      expect((await res.json() as { error: string }).error).toBe(code)
    }
  })

  it('reserve → associate → release lifecycle over HTTP is idempotent', async () => {
    if (!ffmpegAvailable) return
    const up = await api('/api/media', {
      method: 'POST',
      body: JSON.stringify({ images: [{ data: jpegB64 }] }),
    })
    const { attachments } = await up.json() as { attachments: Array<{ id: string }> }
    const id = attachments[0].id

    const reserve = () => api('/api/media/reserve', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], clientQueueItemId: 'q_route_1', sessionId: 'sess1' }),
    })
    expect((await reserve()).status).toBe(200)
    expect((await reserve()).status).toBe(200) // replay OK

    const conflict = await api('/api/media/reserve', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], clientQueueItemId: 'q_route_2' }),
    })
    expect(conflict.status).toBe(409)
    expect((await conflict.json() as { error: string }).error).toBe('media_conflict')

    const assoc = () => api('/api/media/associate', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], globalMsgNum: 101, sessionId: 'sess1' }),
    })
    expect((await assoc()).status).toBe(200)
    expect((await assoc()).status).toBe(200) // replay OK

    // Release after association: no-op — content still served.
    const rel = await api('/api/media/release', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], clientQueueItemId: 'q_route_1' }),
    })
    expect(rel.status).toBe(200)
    expect((await api(`/api/media/${id}/content`)).status).toBe(200)

    // DELETE on associated media is refused.
    const del = await api(`/api/media/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(409)
  })

  it('serves the g2 lens variant: exact 288x144 grayscale PNG, cached on first request', async () => {
    if (!ffmpegAvailable) return
    const up = await api('/api/media', {
      method: 'POST', body: JSON.stringify({ images: [{ data: jpegB64 }] }),
    })
    const { attachments } = await up.json() as { attachments: Array<{ id: string }> }
    const id = attachments[0].id
    for (let round = 0; round < 2; round++) { // second round = cached path
      const res = await api(`/api/media/${id}/content?variant=g2`)
      expect(res.status, `round ${round}`).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(res.headers.get('x-cos-g2-variant')).toBe('png-288x144-v1')
      expect(res.headers.get('access-control-expose-headers')).toContain('X-COS-G2-Variant')
      const bytes = Buffer.from(await res.arrayBuffer())
      // PNG magic + IHDR dims EXACTLY 288x144 (undersized data tiles on-lens)
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      expect(bytes.readUInt32BE(16)).toBe(288)
      expect(bytes.readUInt32BE(20)).toBe(144)
    }
  })

  it('returns distinct typed errors for unknown, malformed, and deleted ids', async () => {
    if (!ffmpegAvailable) return
    const unknown = await api(`/api/media/m_${'0'.repeat(24)}`)
    expect(unknown.status).toBe(404)
    expect((await unknown.json() as { error: string }).error).toBe('media_not_found')

    const traversal = await api('/api/media/..%2f..%2fetc%2fpasswd')
    expect(traversal.status).toBe(400)

    const up = await api('/api/media', {
      method: 'POST', body: JSON.stringify({ images: [{ data: jpegB64 }] }),
    })
    const { attachments } = await up.json() as { attachments: Array<{ id: string }> }
    const id = attachments[0].id
    expect((await api(`/api/media/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await api(`/api/media/${id}`)).status).toBe(404)
    expect((await api(`/api/media/${id}/content`)).status).toBe(404)
  })
})
