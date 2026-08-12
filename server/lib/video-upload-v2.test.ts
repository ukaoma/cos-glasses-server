import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MediaStore, _setMediaStoreForTests, type MediaStore as MediaStoreType } from './media-store.js'
import {
  VideoUploadError,
  VideoUploadRegistry,
  VIDEO_UPLOAD_V2_CHUNK_BYTES,
} from './video-upload-v2.js'

const SERVER_ID = 'srv_video_upload_test_1234'
let scratch = ''
let uploads = ''
let store: MediaStoreType
let previousStore: MediaStoreType | null = null
let mp4: Buffer | null = null
let priorFlag: string | undefined

function createRegistry(now?: () => number): VideoUploadRegistry {
  return new VideoUploadRegistry({
    root: uploads,
    ...(now ? { now } : {}),
    freeDiskReserveBytes: 0,
    maxReservedBytes: 64 * 1024 * 1024,
  })
}

async function receive(registry: VideoUploadRegistry, bytes: Buffer, request = 'phone:0123456789abcdef:fixture') {
  const first = registry.init({
    clientRequestId: request,
    serverInstanceId: SERVER_ID,
    totalBytes: bytes.length,
    mime: 'video/mp4',
    label: 'fixture.mp4',
  })
  for (let index = 0; index < first.chunkCount; index++) {
    const start = index * first.chunkBytes
    await registry.putOriginal(first.uploadId, index, bytes.subarray(start, Math.min(bytes.length, start + first.chunkBytes)), SERVER_ID)
  }
  return first.uploadId
}

beforeAll(() => {
  priorFlag = process.env.COS_VIDEO_UPLOAD_V2
  process.env.COS_VIDEO_UPLOAD_V2 = '1'
  scratch = mkdtempSync(join(tmpdir(), 'cos-video-v2-'))
  uploads = join(scratch, 'upload-registry')
  store = new MediaStore(join(scratch, 'media'))
  previousStore = _setMediaStoreForTests(store)
  try {
    const path = join(scratch, 'fixture.mp4')
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path,
    ])
    mp4 = readFileSync(path)
  } catch { mp4 = null }
})

afterAll(async () => {
  await store?._awaitVideoCompressionForTests()
  _setMediaStoreForTests(previousStore)
  if (priorFlag === undefined) delete process.env.COS_VIDEO_UPLOAD_V2
  else process.env.COS_VIDEO_UPLOAD_V2 = priorFlag
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(uploads, { recursive: true, force: true })
})

describe('durable video upload V2', () => {
  it('makes init and accepted chunks idempotent, but rejects conflicting bytes', async () => {
    const registry = createRegistry()
    const bytes = Buffer.alloc(VIDEO_UPLOAD_V2_CHUNK_BYTES + 10, 7)
    const input = {
      clientRequestId: 'phone:1111111111111111:test', serverInstanceId: SERVER_ID,
      totalBytes: bytes.length, mime: 'video/mp4' as const, label: 'same.mp4',
    }
    const first = registry.init(input)
    expect(registry.init(input).uploadId).toBe(first.uploadId)
    const chunk = bytes.subarray(0, VIDEO_UPLOAD_V2_CHUNK_BYTES)
    await registry.putOriginal(first.uploadId, 0, chunk, SERVER_ID)
    await registry.putOriginal(first.uploadId, 0, chunk, SERVER_ID)
    await expect(registry.putOriginal(first.uploadId, 0, Buffer.alloc(chunk.length, 8), SERVER_ID))
      .rejects.toMatchObject({ code: 'video_upload_conflict' })
  })

  it('survives a registry restart with its exact missing-chunk position', async () => {
    const registry = createRegistry()
    const bytes = Buffer.alloc(VIDEO_UPLOAD_V2_CHUNK_BYTES * 2 + 17, 3)
    const first = registry.init({
      clientRequestId: 'phone:2222222222222222:test', serverInstanceId: SERVER_ID,
      totalBytes: bytes.length, mime: 'video/quicktime',
    })
    await registry.putOriginal(first.uploadId, 0, bytes.subarray(0, first.chunkBytes), SERVER_ID)
    const rebooted = createRegistry()
    expect(rebooted.get(first.uploadId, SERVER_ID)).toMatchObject({
      receivedOriginalChunks: [0], missingOriginalChunks: [1, 2], state: 'receiving',
    })
  })

  it('returns the same terminal receipt after response loss and restart', async (ctx) => {
    if (!mp4) return ctx.skip()
    const registry = createRegistry()
    const uploadId = await receive(registry, mp4, 'phone:3333333333333333:test')
    const published = await registry.finalize(uploadId, SERVER_ID)
    expect(published.state).toBe('published')
    expect(published.attachment?.kind).toBe('user_video')
    expect((await registry.finalize(uploadId, SERVER_ID)).attachment?.id).toBe(published.attachment?.id)
    const rebooted = createRegistry()
    expect(rebooted.get(uploadId, SERVER_ID).attachment?.id).toBe(published.attachment?.id)
    expect(rebooted.status()).toMatchObject({ blocksRestart: false, blocksRollback: true })
    await rebooted.acknowledge(uploadId, SERVER_ID)
    expect(rebooted.status()).toMatchObject({ blocksRestart: false, blocksRollback: false })
  })

  it('expires an unacknowledged receipt without deleting its published media', async (ctx) => {
    if (!mp4) return ctx.skip()
    let now = Date.now()
    const registry = createRegistry(() => now)
    const uploadId = await receive(registry, mp4, 'phone:5555555555555555:test')
    const published = await registry.finalize(uploadId, SERVER_ID)
    const mediaId = published.attachment?.id
    expect(mediaId).toMatch(/^m_[0-9a-f]{24}$/)
    expect(registry.status().blocksRollback).toBe(true)

    now += 24 * 60 * 60_000 + 1
    expect(registry.sweepExpired()).toBe(1)
    expect(registry.status()).toMatchObject({ unacknowledgedPublished: 0, blocksRollback: false })
    expect(mediaId && store.resolveUsable(mediaId).record.ref.id).toBe(mediaId)
  })

  it('fails closed when a request is pinned to another server', () => {
    const registry = createRegistry()
    const progress = registry.init({
      clientRequestId: 'phone:4444444444444444:test', serverInstanceId: SERVER_ID,
      totalBytes: 10, mime: 'video/mp4',
    })
    expect(() => registry.get(progress.uploadId, 'srv_other_server_12345'))
      .toThrowError(VideoUploadError)
  })
})
