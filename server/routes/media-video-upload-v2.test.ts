import { vi } from 'vitest'

const ISOLATED_DATA_DIR = vi.hoisted(() => {
  const base = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const dir = `${base}/cos-video-upload-route-${process.pid}-${Date.now()}`
  process.env.COS_DATA_DIR = dir
  process.env.COS_MEDIA_ROOT = `${dir}/media`
  process.env.COS_VIDEO_UPLOAD_V2 = '1'
  process.env.COS_VIDEO_PHONE_FRAMES = '0'
  return dir
})

import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DATA_DIR } from '../lib/data-dir.js'
import { getServerInstanceId, initializeServerInstanceId } from '../lib/server-instance-id.js'
import { MediaStore, _setMediaStoreForTests } from '../lib/media-store.js'
import {
  VideoUploadRegistry,
  _setVideoUploadRegistryForTests,
} from '../lib/video-upload-v2.js'
import {
  mediaBinaryBodyParser,
  mediaBodyParser,
  mediaRouter,
} from './media.js'

const TOKEN = 'test-token-video-upload-v2'
let server: Server | null = null
let base = ''
let root = ''
let store: MediaStore | null = null
let previousStore: MediaStore | null = null
let registry: VideoUploadRegistry | null = null
let previousRegistry: VideoUploadRegistry | null = null

function buildApp(): express.Express {
  const app = express()
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  })
  app.use('/api/media/file', mediaBinaryBodyParser)
  app.use('/api/media', mediaBodyParser)
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', mediaRouter)
  return app
}

async function json(res: globalThis.Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const serverInstanceId = getServerInstanceId()
  if (!serverInstanceId) throw new Error('server identity unavailable in route test')
  return {
    'x-cos-token': TOKEN,
    'x-cos-server-instance': serverInstanceId,
    ...extra,
  }
}

async function init(clientRequestId = 'route-proof-client-request-0001') {
  const serverInstanceId = getServerInstanceId()
  if (!serverInstanceId) throw new Error('server identity unavailable in route test')
  return json(await fetch(`${base}/api/media/video-upload/init`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', 'x-cos-filename': 'proof.mov' }),
    body: JSON.stringify({
      clientRequestId,
      serverInstanceId,
      totalBytes: 6,
      mime: 'video/quicktime',
    }),
  }))
}

beforeAll(async () => {
  if (DATA_DIR !== ISOLATED_DATA_DIR) throw new Error('video route test data dir is not isolated')
  root = mkdtempSync(join(tmpdir(), 'cos-video-route-store-'))
  initializeServerInstanceId(join(root, 'server-instance-id'))
  store = new MediaStore(root)
  previousStore = _setMediaStoreForTests(store)
  previousRegistry = _setVideoUploadRegistryForTests(null)
  const app = buildApp()
  server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

beforeEach(() => {
  process.env.COS_VIDEO_UPLOAD_V2 = '1'
  rmSync(join(root, 'video-route-drafts'), { recursive: true, force: true })
  registry = new VideoUploadRegistry({ root: join(root, 'video-route-drafts') })
  _setVideoUploadRegistryForTests(registry)
})

afterEach(() => {
  _setVideoUploadRegistryForTests(null)
  registry = null
})

afterAll(async () => {
  _setVideoUploadRegistryForTests(previousRegistry)
  _setMediaStoreForTests(previousStore)
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  rmSync(root, { recursive: true, force: true })
  rmSync(ISOLATED_DATA_DIR, { recursive: true, force: true })
})

describe('resumable video upload V2 HTTP contract', () => {
  it('requires API authentication before exposing a draft', async () => {
    const serverInstanceId = getServerInstanceId()
    if (!serverInstanceId) throw new Error('server identity unavailable in route test')
    const res = await fetch(`${base}/api/media/video-upload/vu_00112233445566778899aabb`, {
      headers: { 'x-cos-server-instance': serverInstanceId },
    })
    expect(res.status).toBe(401)
  })

  it('pins init to the current server identity', async () => {
    const res = await json(await fetch(`${base}/api/media/video-upload/init`, {
      method: 'POST',
      headers: {
        'x-cos-token': TOKEN,
        'x-cos-server-instance': 'different-server-instance',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientRequestId: 'route-proof-client-request-identity',
        serverInstanceId: 'different-server-instance',
        totalBytes: 6,
        mime: 'video/quicktime',
      }),
    }))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('server_identity_mismatch')
  })

  it('resumes the same request, accepts raw chunks, and exposes typed terminal controls', async () => {
    const opened = await init()
    expect(opened.status).toBe(200)
    expect(opened.body.protocol).toBe(1)
    const uploadId = opened.body.uploadId as string

    const reopened = await init()
    expect(reopened.status).toBe(200)
    expect(reopened.body.uploadId).toBe(uploadId)

    const chunk = await json(await fetch(`${base}/api/media/video-upload/${uploadId}/original/0`, {
      method: 'PUT',
      headers: headers({ 'content-type': 'application/octet-stream' }),
      body: new Uint8Array(Buffer.from('abc')),
    }))
    expect(chunk.status).toBe(200)
    expect(chunk.body.receivedOriginalChunks).toEqual([0])

    const probe = await json(await fetch(`${base}/api/media/video-upload/${uploadId}`, {
      headers: headers(),
    }))
    expect(probe.status).toBe(200)
    expect(probe.body.missingOriginalChunks).toEqual([])

    // The declared six-byte video has one 256 KiB chunk. A three-byte body is
    // accepted durably, then finalize rejects the size mismatch without
    // publishing a media record or losing the draft.
    const finalize = await json(await fetch(`${base}/api/media/video-upload/${uploadId}/finalize`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
    }))
    expect(finalize.status).toBe(500)
    expect(finalize.body.error).toBe('video_upload_failed')

    const cancelled = await json(await fetch(`${base}/api/media/video-upload/${uploadId}`, {
      method: 'DELETE',
      headers: headers(),
    }))
    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toMatchObject({ ok: true, dropped: true })
  })
})
