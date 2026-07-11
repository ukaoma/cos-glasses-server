import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveQueryAttachments, QueryAttachmentError } from './query-attachments.js'
import { MediaStore, _setMediaStoreForTests } from './media-store.js'
import { isMediaProcessingReady } from './image-safety.js'
import { cleanupModelImageInputs, type ModelImageInput } from './model-image-input.js'

let ffmpegAvailable = false
let jpeg: Buffer
let root = ''
let store: MediaStore
let prevStore: MediaStore | null = null

beforeAll(async () => {
  ffmpegAvailable = await isMediaProcessingReady()
  root = mkdtempSync(join(tmpdir(), 'cos-query-att-'))
  store = new MediaStore(root)
  prevStore = _setMediaStoreForTests(store)
  if (ffmpegAvailable) {
    jpeg = execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=100x80',
      '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', '-',
    ], { maxBuffer: 8 * 1024 * 1024 })
  }
})

afterAll(() => {
  _setMediaStoreForTests(prevStore)
  rmSync(root, { recursive: true, force: true })
})

describe('resolveQueryAttachments', () => {
  it('returns empty inputs for a text-only query', async () => {
    const out = await resolveQueryAttachments({})
    expect(out.inputs).toEqual([])
    expect(out.refs).toEqual([])
  })

  it('resolves durable attachment ids to server paths, deleteAfterRun=false', async () => {
    if (!ffmpegAvailable) return
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    const out = await resolveQueryAttachments({ attachmentIds: [ref.id] })
    expect(out.inputs).toHaveLength(1)
    expect(out.inputs[0].deleteAfterRun).toBe(false)
    expect(out.inputs[0].path.startsWith(root)).toBe(true)
    expect(existsSync(out.inputs[0].path)).toBe(true)
    expect(out.inputs[0].attachment.id).toBe(ref.id)
    expect(out.ids).toEqual([ref.id])
  })

  it('enforces the reservation queue identity on attachment ids', async () => {
    if (!ffmpegAvailable) return
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.reserve([ref.id], { clientQueueItemId: 'owner-q' })
    await expect(resolveQueryAttachments({ attachmentIds: [ref.id], clientQueueItemId: 'thief-q' }))
      .rejects.toMatchObject({ status: 409, code: 'media_conflict' })
    await expect(resolveQueryAttachments({ attachmentIds: [ref.id] }))
      .rejects.toMatchObject({ status: 409 })
    const ok = await resolveQueryAttachments({ attachmentIds: [ref.id], clientQueueItemId: 'owner-q' })
    expect(ok.inputs).toHaveLength(1)
  })

  it('routes legacy base64 through the media store — no validation bypass', async () => {
    if (!ffmpegAvailable) return
    const out = await resolveQueryAttachments({ images: [jpeg.toString('base64')] })
    expect(out.inputs).toHaveLength(1)
    // A durable store record now exists for the legacy bytes.
    expect(store.getRecord(out.ids[0])).not.toBeNull()
    expect(store.getRecord(out.ids[0])!.lifecycle).toBe('staged')
    // and the single legacy `image` field still works
    const single = await resolveQueryAttachments({ image: jpeg.toString('base64') })
    expect(single.inputs).toHaveLength(1)
  })

  it('rejects invalid legacy payloads with typed errors (no unsafe fallback)', async () => {
    if (!ffmpegAvailable) return
    await expect(resolveQueryAttachments({ images: ['!!!not-base64'] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_base64' })
    await expect(resolveQueryAttachments({ images: [Buffer.from('<svg/>').toString('base64')] }))
      .rejects.toMatchObject({ status: 400, code: 'unsupported_format' })
  })

  it('rejects unknown/expired ids with distinct statuses', async () => {
    if (!ffmpegAvailable) return
    await expect(resolveQueryAttachments({ attachmentIds: ['m_' + '9'.repeat(24)] }))
      .rejects.toMatchObject({ status: 404, code: 'media_not_found' })
    const gone = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.release([gone.id], {})
    await expect(resolveQueryAttachments({ attachmentIds: [gone.id] }))
      .rejects.toMatchObject({ status: 410, code: 'media_expired' })
  })

  it('rejects combined image count over 5 instead of silently truncating', async () => {
    if (!ffmpegAvailable) return
    const refs = await Promise.all(Array.from({ length: 3 }, () => store.ingestImage({ bytes: jpeg, kind: 'user_photo' })))
    await expect(resolveQueryAttachments({
      attachmentIds: refs.map(r => r.id),
      images: Array.from({ length: 4 }, () => jpeg.toString('base64')),
    })).rejects.toMatchObject({ status: 400, code: 'too_many_images' })
  })

  it('rejects six durable ids before the shared id parser can cap them', async () => {
    if (!ffmpegAvailable) return
    const refs = await Promise.all(Array.from({ length: 6 }, () => store.ingestImage({ bytes: jpeg, kind: 'user_photo' })))
    await expect(resolveQueryAttachments({ attachmentIds: refs.map(r => r.id) }))
      .rejects.toMatchObject({ status: 400, code: 'too_many_images' })
  })

  it('surfaces QueryAttachmentError with HTTP status for route-level handling', async () => {
    if (!ffmpegAvailable) return
    try {
      await resolveQueryAttachments({ attachmentIds: ['m_' + '8'.repeat(24)] })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(QueryAttachmentError)
      expect((err as QueryAttachmentError).status).toBe(404)
    }
  })
})

describe('cleanupModelImageInputs', () => {
  it('deletes only deleteAfterRun inputs; durable files stay; idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-cleanup-'))
    const durablePath = join(dir, 'durable.jpg')
    const ephemeralPath = join(dir, 'ephemeral.jpg')
    writeFileSync(durablePath, 'durable')
    writeFileSync(ephemeralPath, 'ephemeral')
    const att = {
      id: 'm_' + 'a'.repeat(24), kind: 'user_photo' as const, mime: 'image/jpeg' as const,
      width: 1, height: 1, createdAt: new Date().toISOString(),
    }
    const inputs: ModelImageInput[] = [
      { path: durablePath, attachment: att, deleteAfterRun: false },
      { path: ephemeralPath, attachment: att, deleteAfterRun: true },
    ]
    cleanupModelImageInputs(inputs)
    expect(existsSync(durablePath)).toBe(true)
    expect(existsSync(ephemeralPath)).toBe(false)
    cleanupModelImageInputs(inputs) // second settle — no throw
    expect(existsSync(durablePath)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
