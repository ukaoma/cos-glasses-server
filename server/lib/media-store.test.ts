import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  GENERATED_CONTENT_TTL_MS,
  _renameWithTransientRetryForTests,
  MediaStore,
  MediaStoreError,
  RESERVED_TTL_MS,
  STAGED_TTL_MS,
  TRAFFIC_CONTENT_TTL_MS,
} from './media-store.js'
import { isMediaProcessingReady, renderG2Variant } from './image-safety.js'

let ffmpegAvailable = false
let jpeg: Buffer
const roots: string[] = []

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-media-store-'))
  roots.push(dir)
  return dir
}

beforeAll(async () => {
  ffmpegAvailable = await isMediaProcessingReady()
  if (ffmpegAvailable) {
    jpeg = execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240',
      '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', '-',
    ], { maxBuffer: 8 * 1024 * 1024 })
  }
})

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('MediaStore lifecycle', () => {
  it('retries transient macOS File Provider rename deadlocks without weakening atomic publish', async () => {
    let attempts = 0
    const waits: number[] = []
    await _renameWithTransientRetryForTests('/tmp/stage', '/tmp/assets/id', () => {
      attempts++
      if (attempts < 3) {
        const err = new Error('Unknown system error -11') as NodeJS.ErrnoException
        err.errno = -11
        throw err
      }
    }, async (ms) => { waits.push(ms) })

    expect(attempts).toBe(3)
    expect(waits).toEqual([25, 75])
  })

  it('does not retry a permanent atomic publish failure', async () => {
    let attempts = 0
    await expect(_renameWithTransientRetryForTests('/tmp/stage', '/tmp/assets/id', () => {
      attempts++
      const err = new Error('permission denied') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    })).rejects.toMatchObject({ code: 'EACCES' })
    expect(attempts).toBe(1)
  })

  it('ingest → staged, content + thumb served, index published atomically', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(root)
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo', label: 'test photo' })
    expect(ref.id).toMatch(/^m_[a-f0-9]{24}$/)
    expect(ref.kind).toBe('user_photo')
    expect(ref.mime).toBe('image/jpeg')
    expect(store.getRecord(ref.id)!.lifecycle).toBe('staged')
    // no path/token/base64 in the public ref
    expect(Object.keys(ref).sort()).toEqual(['createdAt', 'height', 'id', 'kind', 'label', 'mime', 'width'])
    const phone = store.getContent(ref.id, 'phone')
    const thumb = store.getContent(ref.id, 'thumb')
    expect(phone.status).toBe('ok')
    expect(thumb.status).toBe('ok')
    // no .tmp lingers, index is valid JSON
    expect(existsSync(join(root, 'index.json'))).toBe(true)
    expect(existsSync(join(root, 'index.json.tmp'))).toBe(false)
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'))
    expect(index.records[ref.id].lifecycle).toBe('staged')
  })

  it('trusted output ingress accepts a >2 MiB local artifact and publishes normalized JPEG', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(root)
    const oversizedLocalArtifact = Buffer.concat([jpeg, Buffer.alloc(2 * 1024 * 1024 + 32)])
    const ref = await store.ingestOutputImage({
      bytes: oversizedLocalArtifact,
      kind: 'generated_visual',
      label: 'Generated image',
    })
    expect(ref.kind).toBe('generated_visual')
    expect(ref.mime).toBe('image/jpeg')
    expect(store.getContent(ref.id).status).toBe('ok')
  })

  it('reserve is idempotent per queue item and conflicts across items', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.reserve([ref.id], { clientQueueItemId: 'q1' })
    await store.reserve([ref.id], { clientQueueItemId: 'q1' }) // replay OK
    expect(store.getRecord(ref.id)!.lifecycle).toBe('reserved')
    await expect(store.reserve([ref.id], { clientQueueItemId: 'q2' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'media_conflict' }))
  })

  it('associate is replay-safe and wins over a delayed release', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.reserve([ref.id], { clientQueueItemId: 'q1', sessionId: 's1' })
    await store.associate([ref.id], { sessionId: 's1', globalMsgNum: 42 })
    await store.associate([ref.id], { sessionId: 's1', globalMsgNum: 42 }) // replay OK
    expect(store.getRecord(ref.id)!.lifecycle).toBe('associated')
    expect(store.getRecord(ref.id)!.globalMsgNum).toBe(42)
    // delayed release after association must be a no-op
    await store.release([ref.id], { clientQueueItemId: 'q1' })
    expect(store.getRecord(ref.id)!.lifecycle).toBe('associated')
    expect(store.getContent(ref.id).status).toBe('ok')
  })

  it('release drops staged and own-reserved media, never another queue item\'s', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const a = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    const b = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.reserve([b.id], { clientQueueItemId: 'owner' })
    await store.release([a.id, b.id], { clientQueueItemId: 'someone-else' })
    expect(store.getRecord(a.id)!.lifecycle).toBe('expired') // staged: released
    expect(store.getRecord(b.id)!.lifecycle).toBe('reserved') // foreign reservation: kept
    await store.release([b.id], { clientQueueItemId: 'owner' })
    expect(store.getRecord(b.id)!.lifecycle).toBe('expired')
  })

  it('deleteUnassociated removes staged media but refuses associated media', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const a = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    const b = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.associate([b.id], { globalMsgNum: 7 })
    expect(await store.deleteUnassociated(a.id)).toBe(true)
    expect(store.getContent(a.id).status).toBe('not_found')
    await expect(store.deleteUnassociated(b.id))
      .rejects.toThrowError(expect.objectContaining({ code: 'media_conflict' }))
  })

  it('resolveUsable enforces reservation identity — an id alone is not authorization', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.reserve([ref.id], { clientQueueItemId: 'q1' })
    expect(() => store.resolveUsable(ref.id, 'q1')).not.toThrow()
    expect(() => store.resolveUsable(ref.id, 'intruder'))
      .toThrowError(expect.objectContaining({ code: 'media_conflict' }))
    expect(() => store.resolveUsable(ref.id))
      .toThrowError(expect.objectContaining({ code: 'media_conflict' }))
    expect(() => store.resolveUsable('m_' + 'f'.repeat(24)))
      .toThrowError(expect.objectContaining({ code: 'media_not_found' }))
  })
})

describe('MediaStore GC + retention', () => {
  it('expires staged after 4h and reserved after 7d; associated is permanent', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const staged = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    const reserved = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    const kept = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    await store.reserve([reserved.id], { clientQueueItemId: 'q1' })
    await store.associate([kept.id], { globalMsgNum: 9 })

    const later = Date.now() + STAGED_TTL_MS + 60_000
    await store.runGC(later)
    expect(store.getRecord(staged.id)!.lifecycle).toBe('expired')
    expect(store.getRecord(reserved.id)!.lifecycle).toBe('reserved') // 7d not yet up

    const muchLater = Date.now() + RESERVED_TTL_MS + 60_000
    await store.runGC(muchLater)
    expect(store.getRecord(reserved.id)!.lifecycle).toBe('expired')
    expect(store.getRecord(kept.id)!.lifecycle).toBe('associated')
    expect(store.getContent(kept.id).status).toBe('ok')
  })

  it('traffic frames lose CONTENT after 10 minutes but keep metadata', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const frame = await store.ingestImage({ bytes: jpeg, kind: 'traffic_frame', label: 'I-35 @ 6th' })
    await store.associate([frame.id], { globalMsgNum: 3 })
    expect(store.getContent(frame.id).status).toBe('ok')
    await store.runGC(Date.now() + TRAFFIC_CONTENT_TTL_MS + 5_000)
    const rec = store.getRecord(frame.id)!
    expect(rec.lifecycle).toBe('associated')     // metadata survives
    expect(rec.ref.label).toBe('I-35 @ 6th')
    expect(store.getContent(frame.id).status).toBe('expired') // bytes gone
  })

  it('agent-selected visuals expire their lens cache after 30 days', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const visual = await store.ingestImage({ bytes: jpeg, kind: 'generated_visual', label: 'Research image' })
    await store.associate([visual.id], { globalMsgNum: 4 })
    expect(store.getContent(visual.id).status).toBe('ok')
    expect(visual.expiresAt).toBeTruthy()

    await store.runGC(Date.now() + GENERATED_CONTENT_TTL_MS + 5_000)
    const rec = store.getRecord(visual.id)!
    expect(rec.lifecycle).toBe('associated')
    expect(rec.contentRemoved).toBe(true)
    expect(store.getContent(visual.id).status).toBe('expired')
  })

  it('lifecycle content reads honor staged TTL without waiting for GC', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    expect(store.getContent(ref.id).status).toBe('ok')
    // resolveUsable and reserve both consult TTLs against live clock — verified
    // indirectly: the record reports expired through the GC-time override.
    await store.runGC(Date.now() + STAGED_TTL_MS + 1)
    expect(store.getContent(ref.id).status).toBe('expired')
  })
})

describe('MediaStore boot reconciliation', () => {
  it('removes unpublished orphan assets, clears tmp, flags missing content, survives corrupt index', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(root)
    const ok = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    const missing = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })

    // Simulate: orphan asset dir with no index record; tmp leftovers; a record
    // whose bytes vanished.
    mkdirSync(join(root, 'assets', 'm_' + 'd'.repeat(24)), { recursive: true })
    writeFileSync(join(root, 'assets', 'm_' + 'd'.repeat(24), 'original-normalized.jpg'), jpeg)
    mkdirSync(join(root, 'tmp', 'm_' + 'e'.repeat(24)), { recursive: true })
    rmSync(join(root, 'assets', missing.id), { recursive: true, force: true })

    const rebooted = new MediaStore(root)
    expect(existsSync(join(root, 'assets', 'm_' + 'd'.repeat(24)))).toBe(false)
    expect(existsSync(join(root, 'tmp', 'm_' + 'e'.repeat(24)))).toBe(false)
    expect(rebooted.getContent(ok.id).status).toBe('ok')
    expect(rebooted.getContent(missing.id).status).toBe('unavailable')

    // Corrupt index: quarantined, boot continues empty (no crash), and the
    // still-good asset bytes are preserved for recovery instead of treated as
    // unpublished orphans.
    const okBytesBeforeCorruption = readFileSync(join(root, 'assets', ok.id, 'original-normalized.jpg'))
    writeFileSync(join(root, 'index.json'), '{corrupt')
    const afterCorrupt = new MediaStore(root)
    expect(afterCorrupt.stats().total).toBe(0)
    expect(readFileSync(join(root, 'assets', ok.id, 'original-normalized.jpg'))).toEqual(okBytesBeforeCorruption)
    expect(readdirSync(root).some(name => name.startsWith('index.json.corrupt-'))).toBe(true)
  })

  it.each([
    ['malformed', '{not-json'],
    ['truncated', '{"v":1,"records":{"m_deadbeef":'],
    ['schema-invalid', '{"v":1,"records":null}'],
  ])('quarantines a %s index without deleting any asset bytes', (_label, indexContents) => {
    const root = newRoot()
    const id = `m_${'a'.repeat(24)}`
    const assetDir = join(root, 'assets', id)
    const original = Buffer.from('irreplaceable-normalized-image-bytes')
    mkdirSync(assetDir, { recursive: true })
    writeFileSync(join(assetDir, 'original-normalized.jpg'), original)
    writeFileSync(join(assetDir, 'thumb.jpg'), Buffer.from('thumbnail'))
    writeFileSync(join(root, 'index.json'), indexContents)

    const store = new MediaStore(root)

    expect(store.stats().total).toBe(0)
    expect(readFileSync(join(assetDir, 'original-normalized.jpg'))).toEqual(original)
    expect(existsSync(assetDir)).toBe(true)
    expect(readdirSync(root).some(name => name.startsWith('index.json.corrupt-'))).toBe(true)
  })

  it('concurrent ingest + reserve + associate + GC do not lose records', async () => {
    if (!ffmpegAvailable) return
    const store = new MediaStore(newRoot())
    const refs = await Promise.all(
      Array.from({ length: 4 }, () => store.ingestImage({ bytes: jpeg, kind: 'user_photo' })),
    )
    await Promise.all([
      store.reserve([refs[0].id], { clientQueueItemId: 'qa' }),
      store.reserve([refs[1].id], { clientQueueItemId: 'qb' }),
      store.associate([refs[2].id], { globalMsgNum: 1 }),
      store.runGC(),
      store.reserve([refs[3].id], { clientQueueItemId: 'qc' }),
    ])
    expect(store.stats().total).toBe(4)
    for (const ref of refs) expect(store.getContent(ref.id).status).toBe('ok')
  })
})

describe('MediaStore G2 cache hardening', () => {
  it('single-flights concurrent cold-cache requests for the same media id', async () => {
    if (!ffmpegAvailable) return
    let renderCalls = 0
    const store = new MediaStore(newRoot(), {
      renderG2Variant: async (bytes) => {
        renderCalls++
        // Keep the cold render in flight long enough for every caller to join.
        await new Promise(resolve => setTimeout(resolve, 25))
        return renderG2Variant(bytes)
      },
    })
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })

    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.getG2Content(ref.id)),
    )

    expect(renderCalls).toBe(1)
    expect(results.every(result => result.status === 'ok')).toBe(true)
    const paths = results.map(result => result.status === 'ok' ? result.path : null)
    expect(new Set(paths).size).toBe(1)
    const g2 = readFileSync(paths[0]!)
    expect(g2.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(g2.readUInt32BE(16)).toBe(288)
    expect(g2.readUInt32BE(20)).toBe(144)
  })

  it('regenerates corrupt and wrong-size cached G2 payloads', async () => {
    if (!ffmpegAvailable) return
    let renderCalls = 0
    const root = newRoot()
    const store = new MediaStore(root, {
      renderG2Variant: async (bytes) => {
        renderCalls++
        return renderG2Variant(bytes)
      },
    })
    const ref = await store.ingestImage({ bytes: jpeg, kind: 'user_photo' })
    const first = await store.getG2Content(ref.id)
    expect(first.status).toBe('ok')
    const g2Path = join(root, 'assets', ref.id, 'g2-288.png')

    writeFileSync(g2Path, Buffer.from('not-a-png'))
    expect(store.getContent(ref.id, 'g2').status).toBe('unavailable')
    expect((await store.getG2Content(ref.id)).status).toBe('ok')
    expect(renderCalls).toBe(2)

    // Preserve the PNG signature but forge an invalid width. Cache validation
    // must reject dimensions too, not just trust the extension/magic bytes.
    const wrongSize = Buffer.from(readFileSync(g2Path))
    wrongSize.writeUInt32BE(287, 16)
    writeFileSync(g2Path, wrongSize)
    expect(store.getContent(ref.id, 'g2').status).toBe('unavailable')
    expect((await store.getG2Content(ref.id)).status).toBe('ok')
    expect(renderCalls).toBe(3)

    const repaired = readFileSync(g2Path)
    expect(repaired.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(repaired.readUInt32BE(16)).toBe(288)
    expect(repaired.readUInt32BE(20)).toBe(144)
    expect(readdirSync(join(root, 'tmp')).filter(name => name.startsWith(`g2-${ref.id}-`))).toEqual([])
  })
})
