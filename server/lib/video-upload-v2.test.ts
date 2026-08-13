import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MediaStore, _setMediaStoreForTests, type MediaStore as MediaStoreType } from './media-store.js'
import {
  VideoUploadError,
  VideoUploadRegistry,
  VIDEO_UPLOAD_V2_CHUNK_BYTES,
  isStrandedReceivingVideoUpload,
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

  it('advertises 1 MiB for new sessions', () => {
    const registry = createRegistry()
    const progress = registry.init({
      clientRequestId: 'phone:7777777777777777:size', serverInstanceId: SERVER_ID,
      totalBytes: 10, mime: 'video/mp4',
    })
    expect(VIDEO_UPLOAD_V2_CHUNK_BYTES).toBe(1024 * 1024)
    expect(progress.chunkBytes).toBe(1024 * 1024)
    expect(progress.chunkCount).toBe(1)
  })

  it('resumes a 256 KiB draft after the advertised chunk size rises to 1 MiB', async () => {
    const oldChunk = 256 * 1024
    const totalBytes = oldChunk * 2 + 17
    const uploadId = 'vu_aaaaaaaaaaaaaaaaaaaaaaaa'
    const chunk0 = Buffer.alloc(oldChunk, 9)
    const dir = join(uploads, uploadId)
    mkdirSync(join(dir, 'original'), { recursive: true, mode: 0o700 })
    mkdirSync(join(dir, 'frames'), { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'original', '0.bin'), chunk0)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      v: 1,
      uploadId,
      clientRequestId: 'phone:6666666666666666:legacy-chunk',
      serverInstanceId: SERVER_ID,
      state: 'receiving',
      generation: 1,
      totalBytes,
      chunkBytes: oldChunk,
      chunkCount: 3,
      mime: 'video/mp4',
      original: { '0': { bytes: oldChunk, sha256: createHash('sha256').update(chunk0).digest('hex') } },
      frames: {},
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    }))
    const registry = createRegistry()
    expect(registry.get(uploadId, SERVER_ID)).toMatchObject({
      chunkBytes: oldChunk,
      receivedOriginalChunks: [0],
      missingOriginalChunks: [1, 2],
    })
    await expect(registry.putOriginal(uploadId, 0, chunk0, SERVER_ID)).resolves.toMatchObject({
      receivedOriginalChunks: [0],
    })
    await registry.putOriginal(uploadId, 1, Buffer.alloc(oldChunk, 8), SERVER_ID)
    await expect(registry.putOriginal(uploadId, 2, Buffer.alloc(VIDEO_UPLOAD_V2_CHUNK_BYTES, 1), SERVER_ID))
      .rejects.toMatchObject({ code: 'video_upload_invalid' })
    await registry.putOriginal(uploadId, 2, Buffer.alloc(17, 7), SERVER_ID)
    expect(registry.get(uploadId, SERVER_ID).missingOriginalChunks).toEqual([])
  })

  it('accepts two overlapping original PUTs and keeps both indexes', async () => {
    const registry = createRegistry()
    const bytes = Buffer.alloc(VIDEO_UPLOAD_V2_CHUNK_BYTES * 2, 3)
    const first = registry.init({
      clientRequestId: 'phone:7777777777777777:overlap',
      serverInstanceId: SERVER_ID,
      totalBytes: bytes.length,
      mime: 'video/mp4',
      label: 'overlap.mp4',
    })
    const [firstAck, secondAck] = await Promise.all([
      registry.putOriginal(first.uploadId, 0, bytes.subarray(0, first.chunkBytes), SERVER_ID),
      registry.putOriginal(first.uploadId, 1, bytes.subarray(first.chunkBytes), SERVER_ID),
    ])
    const received = [...new Set([...firstAck.receivedOriginalChunks, ...secondAck.receivedOriginalChunks])].sort((a, b) => a - b)
    expect(received).toEqual([0, 1])
    expect(registry.get(first.uploadId, SERVER_ID).missingOriginalChunks).toEqual([])
  })

  it('names only idle receiving drafts as stranded', () => {
    const now = 1_000_000
    expect(isStrandedReceivingVideoUpload({
      state: 'receiving', updatedAtMs: now - 60_000, nowMs: now,
    })).toBe(true)
    expect(isStrandedReceivingVideoUpload({
      state: 'receiving', updatedAtMs: now - 59_999, nowMs: now,
    })).toBe(false)
    expect(isStrandedReceivingVideoUpload({
      state: 'receiving', updatedAtMs: now - 120_000, nowMs: now, activeWriters: 1,
    })).toBe(false)
    expect(isStrandedReceivingVideoUpload({
      state: 'finalizing', updatedAtMs: now - 120_000, nowMs: now,
    })).toBe(false)
    expect(isStrandedReceivingVideoUpload({
      state: 'published', updatedAtMs: now - 120_000, nowMs: now,
    })).toBe(false)
  })

  it('clears idle receiving drafts and leaves a live PUT alone', async () => {
    let now = 1_700_000_000_000
    const registry = createRegistry(() => now)
    const idle = registry.init({
      clientRequestId: 'phone:8888888888888888:stranded',
      serverInstanceId: SERVER_ID,
      totalBytes: 10,
      mime: 'video/mp4',
    })
    now += 1_000
    const live = registry.init({
      clientRequestId: 'phone:9999999999999999:live',
      serverInstanceId: SERVER_ID,
      totalBytes: VIDEO_UPLOAD_V2_CHUNK_BYTES + 10,
      mime: 'video/mp4',
    })
    now += 61_000
    await registry.putOriginal(live.uploadId, 0, Buffer.alloc(VIDEO_UPLOAD_V2_CHUNK_BYTES, 4), SERVER_ID)
    const result = await registry.clearStrandedReceiving(SERVER_ID)
    expect(result.cancelled).toEqual([idle.uploadId])
    expect(result.skipped).toEqual([{ uploadId: live.uploadId, reason: 'recently_updated' }])
    expect(registry.get(live.uploadId, SERVER_ID).state).toBe('receiving')
    expect(registry.status()).toMatchObject({ receiving: 1, blocksRestart: true })
  })
})
