// Phase 1 of the large-video upload contract (docs/media-upload-contract.md):
// the upload body streams to disk, video and other media have DIFFERENT byte
// caps, health publishes those limits, and compression runs as a background job
// that can never destroy the only copy.
//
// The middleware order here is the real one from server/index.ts — auth, then
// the route-scoped binary parser, then the global express.json(). That last one
// matters: it is what an already-drained request body has to survive.

import { vi } from 'vitest'

// MUST run before any import is evaluated. server/lib/data-dir.ts resolves
// DATA_DIR at module scope, and health.ts pulls in the conversation store, which
// restores every session and re-mirrors archive days ON IMPORT. Assigning this
// in beforeAll is too late: the first run of this file rewrote 161 archive files
// in the live ~/.cos-glasses/data while the production server owned them.
// Nothing was lost (the mirror is idempotent) but it was an uncontrolled
// concurrent write, and vi.hoisted is the only assignment point early enough.
const ISOLATED_DATA_DIR = vi.hoisted(() => {
  const base = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const dir = `${base}/cos-upload-limits-data-${process.pid}-${Date.now()}`
  process.env.COS_DATA_DIR = dir
  process.env.COS_MEDIA_ROOT = `${dir}/media`
  process.env.COS_MEETINGS_ROOT = `${dir}/meetings`
  process.env.COS_PROFILE_PATH = `${dir}/.cos-profile.json`
  return dir
})

import express from 'express'
import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { PassThrough } from 'node:stream'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Server } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DATA_DIR } from '../lib/data-dir.js'
import {
  MEDIA_CHUNKED_UPLOAD_ENABLED,
  createMediaBinaryBodyParser,
  mediaBodyParser,
  mediaRouter,
} from './media.js'
import {
  MediaStore,
  _setMediaStoreForTests,
  type CompressVideoFile,
  type CompressionResult,
} from '../lib/media-store.js'
import { VIDEO_COMPRESSION_LABEL } from '../lib/video-compression.js'
import { getUploadSessions } from '../lib/upload-session.js'
import {
  ADVERTISED_VIDEO_COMPRESSION_LABEL,
  MAX_CHUNKED_MEDIA_BYTES,
  MAX_OTHER_MEDIA_BYTES,
  MAX_VIDEO_MEDIA_BYTES,
  MEDIA_CHUNK_BYTES,
  getMediaLimits,
  getRichMediaProcessingCapabilities,
  prepareRichMediaFromFile,
} from '../lib/rich-media-safety.js'

const TOKEN = 'test-token-upload-limits'
// Deliberately tiny stand-ins for the 100 MB / 64 MiB pair. Pushing 100 MB
// through a test would take longer than the behaviour is worth; what needs
// proving is that the ceiling DIFFERS by kind and is enforced while streaming.
const TEST_VIDEO_MAX = 4096
const TEST_OTHER_MAX = 512

let capsServer: Server | null = null
let realServer: Server | null = null
let capsBase = ''
let realBase = ''
let root = ''
let store: MediaStore | null = null
let prevStore: MediaStore | null = null
// A bare `return` here would report as PASSED. These tests guard the contract's
// non-negotiable data-safety rule (the original survives every failure mode), so on a
// box without ffmpeg the file would print all-green while none of that logic ran.
// ffmpegAvailable/mp4 are resolved in async setup, so a collection-time it.skipIf()
// would see their initial values and skip unconditionally — the skip has to be at
// runtime, via ctx.skip(), which the reporter shows as SKIPPED.
let ffmpegAvailable = false
let mp4: Buffer | null = null

/** Swapped per test. The store is constructed once with a stable wrapper so a
 *  test can choose the compressor's outcome without rebuilding the store. */
let compressor: CompressVideoFile = async (_input, _work) => ({
  status: 'skipped_unavailable',
  originalBytes: 0,
})
const compressorCalls: Array<{ inputPath: string; workDir: string; inputExisted: boolean; workDirExisted: boolean }> = []

function buildApp(binary: express.RequestHandler): express.Express {
  const app = express()
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  })
  app.use('/api/media/file', binary)
  app.use('/api/media', mediaBodyParser)
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', mediaRouter)
  return app
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const addr = server.address()
  return { server, base: typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '' }
}

/** POST a binary body. Returns the parsed error/attachment payload, or a
 *  transport marker if the server closed the connection instead of answering. */
async function upload(
  base: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/media/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-cos-token': TOKEN, ...headers },
    body: new Uint8Array(body),
  })
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}

/** Declare a huge Content-Length and then send almost nothing. ONLY the
 *  pre-read header check can answer this: a server that waits for the body it
 *  was promised never replies at all. */
function uploadWithOverstatedLength(
  base: string,
  declaredLength: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/api/media/file`)
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/api/media/file',
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-cos-token': TOKEN,
        'content-length': String(declaredLength),
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { raw: text } }
        request.destroy()
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    request.on('error', reject)
    request.write(Buffer.alloc(8, 0x61)) // far fewer bytes than promised
    // Deliberately never end() — the server must not be waiting on us.
  })
}

/** A body whose magic bytes say ISO-BMFF ('ftyp' at offset 4) without being a
 *  decodable video — enough to select the video cap, not enough to ingest. */
function isoBmffBody(size: number): Buffer {
  const buffer = Buffer.alloc(size, 0x41)
  buffer.write('ftyp', 4, 'ascii')
  return buffer
}

function tmpEntries(): string[] {
  return readdirSync(join(root, 'tmp'))
}

beforeAll(async () => {
  // Proof, not assumption: if the hoisted assignment ever stops landing before
  // data-dir.ts evaluates, refuse to run rather than write to the real home.
  if (DATA_DIR !== ISOLATED_DATA_DIR) {
    throw new Error(`data dir not isolated: ${DATA_DIR} !== ${ISOLATED_DATA_DIR}`)
  }
  ffmpegAvailable = (await getRichMediaProcessingCapabilities()).video
  root = mkdtempSync(join(tmpdir(), 'cos-upload-limits-'))
  store = new MediaStore(root, {
    compressVideoFile: async (inputPath, workDir) => {
      compressorCalls.push({
        inputPath,
        workDir,
        inputExisted: existsSync(inputPath),
        workDirExisted: existsSync(workDir),
      })
      return compressor(inputPath, workDir)
    },
  })
  prevStore = _setMediaStoreForTests(store)
  if (ffmpegAvailable) {
    const scratch = mkdtempSync(join(tmpdir(), 'cos-upload-src-'))
    const path = join(scratch, 'clip.mp4')
    execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5',
      '-t', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
    ])
    mp4 = readFileSync(path)
    rmSync(scratch, { recursive: true, force: true })
  }
  ;({ server: capsServer, base: capsBase } = await listen(buildApp(
    createMediaBinaryBodyParser({ videoMaxBytes: TEST_VIDEO_MAX, otherMaxBytes: TEST_OTHER_MAX }),
  )))
  ;({ server: realServer, base: realBase } = await listen(buildApp(createMediaBinaryBodyParser())))
})

afterAll(async () => {
  _setMediaStoreForTests(prevStore)
  await new Promise<void>((resolve) => capsServer ? capsServer.close(() => resolve()) : resolve())
  await new Promise<void>((resolve) => realServer ? realServer.close(() => resolve()) : resolve())
  rmSync(root, { recursive: true, force: true })
  rmSync(ISOLATED_DATA_DIR, { recursive: true, force: true })
})

afterEach(async () => {
  await store?._awaitVideoCompressionForTests()
  // Standing invariant, not a nicety: fs.createWriteStream opens lazily, and the
  // first version of the parser leaked one staging file per REJECTED upload
  // because destroy()+unlink raced that open. Assert after every test so any
  // future path that forgets to dispose fails here.
  expect(tmpEntries()).toEqual([])
  compressorCalls.length = 0
  compressor = async () => ({ status: 'skipped_unavailable', originalBytes: 0 })
})

describe('advertised media limits', () => {
  it('publishes the contract byte caps, chunk geometry, and encode label', async () => {
    // Frozen numbers. A client that hardcodes its own copy drifts; these are
    // the values it reads instead.
    expect(MAX_VIDEO_MEDIA_BYTES).toBe(104857600)
    expect(MAX_OTHER_MEDIA_BYTES).toBe(67108864)
    expect(MEDIA_CHUNK_BYTES).toBe(8388608)
    expect(MAX_CHUNKED_MEDIA_BYTES).toBe(2147483648)

    const capabilities = await getRichMediaProcessingCapabilities()
    const limits = await getMediaLimits({ chunkedUploadEnabled: MEDIA_CHUNKED_UPLOAD_ENABLED })
    expect(Object.keys(limits).sort()).toEqual([
      'chunkBytes', 'chunkedMaxBytes', 'chunkedUploadEnabled',
      'otherMaxBytes', 'videoCompression', 'videoMaxBytes',
    ])
    expect(limits).toMatchObject({
      videoMaxBytes: 104857600,
      otherMaxBytes: 67108864,
      chunkBytes: 8388608,
      chunkedMaxBytes: 2147483648,
      chunkedUploadEnabled: MEDIA_CHUNKED_UPLOAD_ENABLED,
    })
    // null, not false, and never a label when the encoder cannot run.
    expect(limits.videoCompression).toBe(capabilities.video ? 'x265-crf30' : null)
  })

  it('advertises the same label the compressor actually stamps', () => {
    // These two constants cannot be a single import — video-compression.ts
    // imports rich-media-safety.ts, so the reverse would be a cycle. This is
    // the only thing stopping them from drifting apart.
    expect(ADVERTISED_VIDEO_COMPRESSION_LABEL).toBe(VIDEO_COMPRESSION_LABEL)
  })

  it('enforces the real 100 MB / 64 MiB split without moving 100 MB', async (ctx) => {
    // byteLength is the caller's own measurement of the staged file, so an
    // overstated size exercises the production constants against a tiny file.
    const scratch = mkdtempSync(join(tmpdir(), 'cos-cap-'))
    const textPath = join(scratch, 'notes.txt')
    writeFileSync(textPath, 'short\n')
    const overOther = MAX_OTHER_MEDIA_BYTES + 1
    try {
      await expect(prepareRichMediaFromFile(textPath, { label: 'notes.txt', byteLength: overOther }))
        .rejects.toMatchObject({ code: 'attachment_too_large' })

      if (!ffmpegAvailable || !mp4) return ctx.skip()
      const videoPath = join(scratch, 'clip.mp4')
      writeFileSync(videoPath, mp4)
      // The same overstated size is fine for video: it is under 100 MB.
      const prepared = await prepareRichMediaFromFile(videoPath, {
        label: 'clip.mp4', declaredMime: 'video/mp4', byteLength: overOther,
      })
      expect(prepared.category).toBe('video')
      // Over 100 MB, video is refused too — the cap rose, it did not vanish.
      await expect(prepareRichMediaFromFile(videoPath, {
        label: 'clip.mp4', declaredMime: 'video/mp4', byteLength: MAX_VIDEO_MEDIA_BYTES + 1,
      })).rejects.toMatchObject({ code: 'attachment_too_large' })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 60_000)

  it('only advertises chunked upload when its endpoints actually answer', async () => {
    // Honesty gate stated as an IMPLICATION rather than as the flag's current
    // value: whichever way the flag points, the endpoints must agree with it.
    // The previous version asserted `toBe(false)` plus a 404 probe, and had to be
    // rewritten the moment the routes landed — exactly when the assertion needed
    // to still mean something. A GET of an unknown id cannot carry this on its
    // own either: a mounted route ALSO answers 404 there, so the discriminator is
    // whether init works and whether the 404 body is typed.
    const opened = await fetch(`${capsBase}/api/media/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cos-token': TOKEN },
      body: JSON.stringify({ totalBytes: 1024, mime: 'video/mp4' }),
    })
    if (!MEDIA_CHUNKED_UPLOAD_ENABLED) {
      // Unmounted: Express's own untyped 404, never a route's JSON error.
      expect(opened.status).toBe(404)
      expect(((await opened.json().catch(() => ({}))) as { error?: string }).error).toBeUndefined()
      return
    }
    expect(opened.status).toBe(200)
    const session = await opened.json() as { uploadId: string; chunkBytes: number; receivedBytes: number }
    expect(session.chunkBytes).toBe(MEDIA_CHUNK_BYTES)
    expect(session.receivedBytes).toBe(0)
    // Release the staging file this opened: the afterEach tmp/ invariant is a
    // standing guard over every path in this file, including this one.
    expect(getUploadSessions().drop(session.uploadId)).toBe(true)
  })
})

describe('GET /api/health mediaLimits', () => {
  let healthServer: Server | null = null
  let healthBase = ''

  beforeAll(async () => {
    const identity = await import('../lib/server-instance-id.js')
    identity.initializeServerInstanceId(join(root, 'server-instance-id'))
    const { healthRouter } = await import('./health.js')
    const app = express()
    app.use('/api', healthRouter)
    ;({ server: healthServer, base: healthBase } = await listen(app))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => healthServer ? healthServer.close(() => resolve()) : resolve())
  })

  it('carries the limits block so the client never hardcodes a cap', async () => {
    const res = await fetch(`${healthBase}/api/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      mediaLimits?: Record<string, unknown>
      capabilities?: { richMedia?: Record<string, unknown> }
    }
    const expected = await getMediaLimits({ chunkedUploadEnabled: MEDIA_CHUNKED_UPLOAD_ENABLED })
    expect(body.mediaLimits).toEqual(expected)
    expect(body.mediaLimits?.videoMaxBytes).toBe(104857600)
    expect(body.mediaLimits?.otherMaxBytes).toBe(67108864)
    // The older capability block must not contradict the new one: its single
    // maxBytes value is the NON-video cap and says so.
    expect(body.capabilities?.richMedia).toMatchObject({
      maxBytesPerAttachment: 67108864,
      maxVideoBytesPerAttachment: 104857600,
    })
  })
})

describe('streaming upload body to disk', () => {
  it('stages a text upload, moves it into the asset, and leaves no staging file', async () => {
    const bytes = Buffer.from('Quarterly brief\nRevenue: 42\n')
    const res = await upload(capsBase, bytes, {
      'Content-Type': 'text/plain',
      'X-COS-Filename': 'brief.txt',
    })
    expect(res.status).toBe(200)
    const attachment = res.body.attachment as { id: string; bytes: number }
    expect(attachment.bytes).toBe(bytes.length)

    const content = store!.getContent(attachment.id)
    expect(content.status).toBe('ok')
    if (content.status !== 'ok') return
    // Byte-for-byte: the staged file was MOVED, not re-encoded or re-written.
    expect(readFileSync(content.path)).toEqual(bytes)
    expect(tmpEntries()).toEqual([])
  })

  it('survives an upload sent as application/json past the global JSON parser', async () => {
    // A .json attachment is a supported format, so this Content-Type is legal
    // here. Without telling downstream parsers the body is already consumed,
    // the global express.json() reads a drained stream and fails the request.
    const bytes = Buffer.from('{"fact":"launch is Tuesday"}')
    const res = await upload(capsBase, bytes, {
      'Content-Type': 'application/json',
      'X-COS-Filename': 'facts.json',
    })
    expect(res.status).toBe(200)
    expect((res.body.attachment as { mime: string }).mime).toBe('application/json')
  }, 10_000)

  it('refuses an oversized body and keeps nothing on disk', async () => {
    const res = await upload(capsBase, Buffer.alloc(TEST_OTHER_MAX + 64, 0x61), {
      'Content-Type': 'text/plain',
      'X-COS-Filename': 'huge.txt',
    })
    expect(res.status).toBe(413)
    expect(res.body.error).toBe('attachment_too_large')
    expect(tmpEntries()).toEqual([])
  })

  it('refuses an oversized declared length before opening a staging file', async () => {
    // Content-Length is authoritative when present, so nothing should be
    // written at all — not even the first chunk.
    const res = await upload(capsBase, isoBmffBody(TEST_VIDEO_MAX + 128))
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ error: 'attachment_too_large', maxBytes: TEST_VIDEO_MAX })
    expect(tmpEntries()).toEqual([])
  })

  it('answers an overstated Content-Length without reading the promised body', async () => {
    // Isolates the header pre-check from the streaming ceiling: only 8 bytes are
    // ever sent, so the streaming counter can never trip. If this hangs, the
    // pre-check is gone.
    const res = await uploadWithOverstatedLength(capsBase, TEST_VIDEO_MAX + 1)
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ error: 'attachment_too_large', maxBytes: TEST_VIDEO_MAX })
    expect(tmpEntries()).toEqual([])
  }, 10_000)
})

describe('two different caps, chosen by what is arriving', () => {
  it('applies the video ceiling to ISO-BMFF and the smaller one to the same-sized text body', async () => {
    const size = TEST_OTHER_MAX + 256 // over `other`, under `video`
    const asVideo = await upload(capsBase, isoBmffBody(size))
    // Not a decodable video, so ingest still rejects it — but NOT for size.
    expect(asVideo.status).not.toBe(413)
    expect(asVideo.body.error).not.toBe('attachment_too_large')

    const asText = await upload(capsBase, Buffer.alloc(size, 0x61), {
      'Content-Type': 'text/plain',
      'X-COS-Filename': 'notes.txt',
    })
    expect(asText.status).toBe(413)
    expect(asText.body).toMatchObject({ error: 'attachment_too_large', maxBytes: TEST_OTHER_MAX })
  })

  it('does not let a declared video Content-Type buy the larger ceiling', async () => {
    // Byte-authoritative classification: the header claims video, the magic
    // bytes say text, so the 512-byte cap applies.
    const res = await upload(capsBase, Buffer.alloc(TEST_OTHER_MAX + 256, 0x61), {
      'Content-Type': 'video/mp4',
      'X-COS-Filename': 'liar.mp4',
    })
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ maxBytes: TEST_OTHER_MAX })
  })
})

/** Drive the middleware directly so chunk boundaries are ours to choose. The
 *  12-byte sniff window can arrive split across several chunks, and that branch
 *  is unreachable through fetch, which delivers a small body in one piece. */
function runParserWithChunks(chunks: Buffer[]): Promise<{ status: number; body: Record<string, unknown>; nexted: boolean }> {
  return new Promise((resolve, reject) => {
    const req = new PassThrough() as unknown as Request & PassThrough
    req.method = 'POST'
    req.header = ((name: string) => (name.toLowerCase() === 'content-type' ? 'application/octet-stream' : undefined)) as Request['header']
    let status = 200
    const res = {
      status(code: number) { status = code; return this },
      json(payload: Record<string, unknown>) { resolve({ status, body: payload, nexted: false }); return this },
      once(event: string, listener: () => void) { if (event === 'finish') setImmediate(listener); return this },
    } as unknown as Response
    const next: NextFunction = () => resolve({ status, body: {}, nexted: true })
    try {
      createMediaBinaryBodyParser({ videoMaxBytes: TEST_VIDEO_MAX, otherMaxBytes: TEST_OTHER_MAX })(req, res, next)
    } catch (err) {
      reject(err)
      return
    }
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

describe('sniffing the kind across chunk boundaries', () => {
  it('tightens to the video ceiling even when the 12-byte head arrives in pieces', async () => {
    const body = isoBmffBody(TEST_OTHER_MAX + 256)
    const chunks: Buffer[] = []
    for (let offset = 0; offset < body.length; offset += 5) chunks.push(body.subarray(offset, offset + 5))
    expect(chunks[0].length).toBe(5) // head genuinely split
    const result = await runParserWithChunks(chunks)
    expect(result.nexted).toBe(true)
    expect(result.status).not.toBe(413)
    // Staged body is real and complete.
    const staged = tmpEntries()
    expect(staged).toHaveLength(1)
    rmSync(join(root, 'tmp', staged[0]), { force: true })
  })

  it('still refuses a piecewise non-video body over the smaller ceiling', async () => {
    const body = Buffer.alloc(TEST_OTHER_MAX + 256, 0x61)
    const chunks: Buffer[] = []
    for (let offset = 0; offset < body.length; offset += 5) chunks.push(body.subarray(offset, offset + 5))
    const result = await runParserWithChunks(chunks)
    expect(result.nexted).toBe(false)
    expect(result.status).toBe(413)
    expect(result.body).toMatchObject({ error: 'attachment_too_large', maxBytes: TEST_OTHER_MAX })
    expect(tmpEntries()).toEqual([])
  })
})

describe('background video compression', () => {
  it('does not hold the upload response open while the encode runs', async (ctx) => {
    if (!ffmpegAvailable || !mp4) return ctx.skip()
    let release: (() => void) | null = null
    const started = new Promise<void>((resolve) => {
      compressor = async () => {
        resolve()
        await new Promise<void>((unblock) => { release = unblock })
        return { status: 'failed', originalBytes: mp4!.length, reason: 'test' }
      }
    })
    const res = await upload(realBase, mp4, { 'Content-Type': 'video/mp4', 'X-COS-Filename': 'clip.mp4' })
    expect(res.status).toBe(200) // returned while the encode is still pending
    await started
    expect(release).not.toBeNull()
    release!()
    await store!._awaitVideoCompressionForTests()
    const id = (res.body.attachment as { id: string }).id
    const content = store!.getContent(id)
    expect(content.status).toBe('ok')
    if (content.status !== 'ok') return
    expect(readFileSync(content.path)).toEqual(mp4)
  }, 60_000)

  it('swaps a smaller encode into place and updates the stored size', async (ctx) => {
    if (!ffmpegAvailable || !mp4) return ctx.skip()
    const smaller = Buffer.alloc(Math.floor(mp4.length / 3), 0x7a)
    compressor = async (inputPath, workDir) => {
      const outputPath = join(workDir, 'compressed.mp4')
      writeFileSync(outputPath, smaller)
      return {
        status: 'compressed',
        outputPath,
        originalBytes: statSync(inputPath).size,
        compressedBytes: smaller.length,
      }
    }
    const ref = await store!.ingestRichMedia({
      bytes: mp4, label: 'swap.mp4', declaredMime: 'video/mp4',
    })
    await store!._awaitVideoCompressionForTests(ref.id)

    const call = compressorCalls.at(-1)!
    // The module gets the published asset path, and it still exists when
    // called: nothing may require the compressor to move or delete its input.
    expect(call.inputPath).toBe(join(root, 'assets', ref.id, 'original.mp4'))
    expect(call.inputExisted).toBe(true)
    // workDir must be pre-created AND under the media root, or the rename into
    // place would be a cross-device move and fail EXDEV.
    expect(call.workDirExisted).toBe(true)
    expect(call.workDir.startsWith(join(root, 'tmp'))).toBe(true)
    expect(existsSync(call.workDir)).toBe(false) // cleaned up afterwards

    const record = store!.getRecord(ref.id)!
    expect(readFileSync(join(root, 'assets', ref.id, 'original.mp4'))).toEqual(smaller)
    expect(record.bytes).toBe(smaller.length)
    expect(record.ref.bytes).toBe(smaller.length)
    expect(record.videoCompression).toMatchObject({
      label: 'x265-crf30',
      originalBytes: mp4.length,
      bytes: smaller.length,
    })
    // Provenance has to survive a restart, or the size drop becomes unexplained.
    expect(new MediaStore(root).getRecord(ref.id)?.videoCompression?.bytes).toBe(smaller.length)
  }, 60_000)

  // A plain loop rather than it.each: the `as const` row tuples give it.each no typed
  // slot for the test context, and this suite needs ctx.skip() at RUNTIME because
  // ffmpegAvailable/mp4 are only known after async setup. A bare early return here
  // would report as PASSED, which is precisely the false green being removed.
  const untouchedCases = [
    ['failed', undefined],
    ['skipped_not_smaller', undefined],
    ['skipped_not_video', undefined],
    ['skipped_unavailable', undefined],
    // A module that reports success but hands back a file that is not smaller
    // is still a failure: measured, two encoder settings INFLATED the source.
    ['compressed', 'not-smaller'],
    // The dangerous shape: a rejected encode whose output file is still lying
    // around and smaller. Only the STATUS says not to use it.
    ['skipped_not_smaller', 'with-smaller-output'],
  ] as const
  for (const [status, variant] of untouchedCases) {
  it(`keeps the original untouched on ${status} (${variant})`, async (ctx) => {
    if (!ffmpegAvailable || !mp4) return ctx.skip()
    compressor = async (inputPath, workDir) => {
      const result: CompressionResult = { status, originalBytes: statSync(inputPath).size }
      if (variant === 'not-smaller') {
        const outputPath = join(workDir, 'inflated.mp4')
        writeFileSync(outputPath, Buffer.alloc(statSync(inputPath).size + 1024, 0x7a))
        result.outputPath = outputPath
        result.compressedBytes = statSync(outputPath).size
      }
      if (variant === 'with-smaller-output') {
        const outputPath = join(workDir, 'rejected.mp4')
        writeFileSync(outputPath, Buffer.alloc(Math.floor(statSync(inputPath).size / 4), 0x7a))
        result.outputPath = outputPath
        result.compressedBytes = statSync(outputPath).size
      }
      return result
    }
    const ref = await store!.ingestRichMedia({
      bytes: mp4, label: `keep-${status}-${variant ?? 'plain'}.mp4`, declaredMime: 'video/mp4',
    })
    await store!._awaitVideoCompressionForTests(ref.id)

    const assetPath = join(root, 'assets', ref.id, 'original.mp4')
    expect(readFileSync(assetPath)).toEqual(mp4)
    const record = store!.getRecord(ref.id)!
    expect(record.bytes).toBe(mp4.length)
    expect(record.videoCompression).toBeUndefined()
    expect(tmpEntries()).toEqual([]) // work dir cleaned up either way
  }, 60_000)
  }

  it('does not resurrect an asset deleted while the encode was running', async (ctx) => {
    if (!ffmpegAvailable || !mp4) return ctx.skip()
    const smaller = Buffer.alloc(Math.floor(mp4.length / 3), 0x7a)
    compressor = async (inputPath, workDir) => {
      // The id is recoverable from the path the store handed us.
      const id = basename(dirname(inputPath))
      await store!.deleteUnassociated(id)
      const outputPath = join(workDir, 'compressed.mp4')
      writeFileSync(outputPath, smaller)
      return { status: 'compressed', outputPath, originalBytes: mp4!.length, compressedBytes: smaller.length }
    }
    const ref = await store!.ingestRichMedia({
      bytes: mp4, label: 'raced.mp4', declaredMime: 'video/mp4',
    })
    await store!._awaitVideoCompressionForTests(ref.id)

    const record = store!.getRecord(ref.id)!
    expect(record.lifecycle).toBe('deleted')
    expect(record.videoCompression).toBeUndefined()
    // The whole asset dir went with the delete; compression must not put bytes
    // back into it.
    expect(existsSync(join(root, 'assets', ref.id))).toBe(false)
  }, 60_000)

  it('leaves the asset alone when the record is retired mid-encode', async (ctx) => {
    if (!ffmpegAvailable || !mp4) return ctx.skip()
    const smaller = Buffer.alloc(Math.floor(mp4.length / 3), 0x7a)
    compressor = async (inputPath, workDir) => {
      // Reached through the live record on purpose. Every real retirement path
      // (delete, release, GC) ALSO removes the asset directory, so the rename
      // would fail on a missing parent and mask the lifecycle re-check — this
      // leaves the bytes on disk so only the re-check can refuse the swap.
      store!.getRecord(basename(dirname(inputPath)))!.lifecycle = 'expired'
      const outputPath = join(workDir, 'compressed.mp4')
      writeFileSync(outputPath, smaller)
      return { status: 'compressed', outputPath, originalBytes: mp4!.length, compressedBytes: smaller.length }
    }
    const ref = await store!.ingestRichMedia({
      bytes: mp4, label: 'retired.mp4', declaredMime: 'video/mp4',
    })
    await store!._awaitVideoCompressionForTests(ref.id)

    expect(readFileSync(join(root, 'assets', ref.id, 'original.mp4'))).toEqual(mp4)
    const record = store!.getRecord(ref.id)!
    expect(record.bytes).toBe(mp4.length)
    expect(record.videoCompression).toBeUndefined()
  }, 60_000)

  it('never runs for a document upload', async () => {
    await store!.ingestRichMedia({
      bytes: Buffer.from('not a video\n'), label: 'note.txt', declaredMime: 'text/plain',
    })
    await store!._awaitVideoCompressionForTests()
    expect(compressorCalls).toHaveLength(0)
  })
})
