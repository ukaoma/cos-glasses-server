// Chunked upload, contract §2 wire shape and §6 v1 decisions.
//
// This file is about the FAILURE semantics. The happy path is one test; the rest
// are the cases that decide whether a 2 GB upload over a phone link corrupts an
// asset or merely fails cleanly: out-of-order chunks, a re-sent chunk, the
// ceiling tripping mid-upload, a truncated assembly, expiry, an unknown id, and
// a rejected finalize.
//
// Routes run through the REAL middleware order from server/index.ts, because the
// thing most likely to break this feature is a body parser eating the chunk:
// verified, a PUT sent as application/json is consumed upstream and arrives with
// req.body set, which is exactly the case the parser has to refuse legibly.

import { vi } from 'vitest'

// MUST run before any import is evaluated — server/lib/data-dir.ts resolves
// DATA_DIR at module scope, and media-store.ts derives its default root from it
// at module scope too. Assigning in beforeAll is too late; the sibling
// media-upload-limits.test.ts rewrote 161 files in the live ~/.cos-glasses/data
// learning this.
const ISOLATED_DATA_DIR = vi.hoisted(() => {
  const base = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')
  const dir = `${base}/cos-chunked-upload-data-${process.pid}-${Date.now()}`
  process.env.COS_DATA_DIR = dir
  process.env.COS_MEDIA_ROOT = `${dir}/media`
  process.env.COS_MEETINGS_ROOT = `${dir}/meetings`
  process.env.COS_PROFILE_PATH = `${dir}/.cos-profile.json`
  return dir
})

import express from 'express'
import { PassThrough } from 'node:stream'
import { existsSync, readFileSync, readdirSync, rmSync, mkdtempSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DATA_DIR } from '../lib/data-dir.js'
import {
  MEDIA_CHUNKED_UPLOAD_ENABLED,
  createMediaChunkBodyParser,
  mediaBinaryBodyParser,
  mediaBodyParser,
  mediaRouter,
} from './media.js'
import { MediaStore, _setMediaStoreForTests } from '../lib/media-store.js'
import {
  CHUNKED_UPLOAD_TTL_MS,
  MAX_CONCURRENT_CHUNKED_UPLOADS,
  UploadSessionRegistry,
  _setUploadSessionsForTests,
  defaultUploadSessionFs,
  isValidUploadId,
  type UploadSessionFs,
} from '../lib/upload-session.js'
import { MAX_CHUNKED_MEDIA_BYTES, MEDIA_CHUNK_BYTES } from '../lib/rich-media-safety.js'

const TOKEN = 'test-token-chunked-upload'
/** A well-formed id that this server never minted — the "unknown upload" probe. */
const ABSENT_UPLOAD_ID = 'u_00112233445566778899aabb'

let server: Server | null = null
let base = ''
let root = ''
let store: MediaStore | null = null
let prevStore: MediaStore | null = null
let registry: UploadSessionRegistry | null = null
let prevRegistry: UploadSessionRegistry | null = null
/** Fake clock. Only expiry cares, but it also keeps expiresAt deterministic. */
let clockMs = 0

function buildApp(): express.Express {
  const app = express()
  // EXACT order from server/index.ts: auth, then the route-scoped binary parser
  // for single-shot, then the 16 MB media JSON parser, then the global 10 MB
  // JSON parser. The chunk parser is route-level middleware inside mediaRouter,
  // so init/finalize keep the JSON parser and PUT keeps raw bytes.
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

interface JsonResponse { status: number; body: Record<string, unknown> }

async function readJson(res: Response_): Promise<JsonResponse> {
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: res.status, body }
}
type Response_ = Awaited<ReturnType<typeof fetch>>

function init(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return fetch(`${base}/api/media/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cos-token': TOKEN, ...headers },
    body: JSON.stringify(body),
  }).then(readJson)
}

function putChunk(
  uploadId: string,
  index: number | string,
  bytes: Buffer,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  return fetch(`${base}/api/media/upload/${uploadId}/${index}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-cos-token': TOKEN, ...headers },
    body: new Uint8Array(bytes),
  }).then(readJson)
}

function probe(uploadId: string): Promise<JsonResponse> {
  return fetch(`${base}/api/media/upload/${uploadId}`, {
    method: 'GET',
    headers: { 'x-cos-token': TOKEN },
  }).then(readJson)
}

function cancel(uploadId: string): Promise<JsonResponse> {
  return fetch(`${base}/api/media/upload/${uploadId}`, {
    method: 'DELETE',
    headers: { 'x-cos-token': TOKEN },
  }).then(readJson)
}

function finalize(uploadId: string): Promise<JsonResponse> {
  return fetch(`${base}/api/media/upload/${uploadId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cos-token': TOKEN },
  }).then(readJson)
}

/** Install a registry for one test. Defaults match production geometry; a test
 *  overrides only the seam it is exercising. */
function installRegistry(options: {
  ttlMs?: number
  maxBytes?: number
  maxChunkBytes?: number
  maxConcurrent?: number
  fs?: Partial<UploadSessionFs>
} = {}): UploadSessionRegistry {
  registry = new UploadSessionRegistry({
    createStagingFile: () => store!.createStagingFile(),
    now: () => clockMs,
    ...options,
  })
  _setUploadSessionsForTests(registry)
  return registry
}

/** Open an upload and return its id, failing loudly rather than returning an
 *  undefined id that would make a later assertion pass for the wrong reason. */
async function openUpload(totalBytes: number, body: Record<string, unknown> = {}): Promise<string> {
  const res = await init({ totalBytes, mime: 'text/plain', ...body }, { 'X-COS-Filename': 'notes.txt' })
  expect(res.status).toBe(200)
  const uploadId = res.body.uploadId
  expect(isValidUploadId(uploadId)).toBe(true)
  return uploadId as string
}

function tmpEntries(): string[] {
  return readdirSync(join(root, 'tmp'))
}

/** Published asset ids. assets/ accumulates across tests in this file, so every
 *  "nothing was published" assertion has to be a DELTA — an absolute toEqual([])
 *  passes only while it runs first, which is how a real guard gets a test that
 *  proves nothing. */
function assetIds(): string[] {
  return readdirSync(join(root, 'assets'))
}

function expectNoNewAssets(before: string[]): void {
  expect(assetIds().sort()).toEqual([...before].sort())
}

beforeAll(async () => {
  // Proof, not assumption: if the hoisted assignment ever stops landing before
  // data-dir.ts evaluates, refuse to run rather than write to the real home.
  if (DATA_DIR !== ISOLATED_DATA_DIR) {
    throw new Error(`data dir not isolated: ${DATA_DIR} !== ${ISOLATED_DATA_DIR}`)
  }
  root = mkdtempSync(join(tmpdir(), 'cos-chunked-'))
  store = new MediaStore(root)
  prevStore = _setMediaStoreForTests(store)
  prevRegistry = _setUploadSessionsForTests(null)
  const app = buildApp()
  server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const addr = server.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})

afterAll(async () => {
  _setMediaStoreForTests(prevStore)
  _setUploadSessionsForTests(prevRegistry)
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  rmSync(root, { recursive: true, force: true })
  rmSync(ISOLATED_DATA_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  clockMs = 1_760_000_000_000
  installRegistry()
})

afterEach(async () => {
  await store?._awaitVideoCompressionForTests()
  // Retire whatever the test left in flight, then assert tmp/ is empty. Standing
  // invariant: every terminal path — drop, expiry, finalize, rejected finalize —
  // must release its staging file, or an abandoned 2 GB upload leaks the disk.
  registry?.sweepExpired(Number.MAX_SAFE_INTEGER)
  expect(registry?.size()).toBe(0)
  expect(tmpEntries()).toEqual([])
  _setUploadSessionsForTests(null)
  registry = null
})

describe('the feature gate is honest about itself', () => {
  it('answers a real init/probe round-trip whenever health advertises the flag', async () => {
    // Stated as an IMPLICATION rather than as the constant's current value: if
    // health says chunked upload is on, the endpoints must actually answer.
    // Asserting `toBe(true)` would pass just as well with the routes deleted.
    if (!MEDIA_CHUNKED_UPLOAD_ENABLED) {
      const absent = await probe(ABSENT_UPLOAD_ID)
      expect(absent.status).toBe(404)
      expect(absent.body.error).toBeUndefined() // Express's own 404, untyped
      return
    }
    const uploadId = await openUpload(4)
    const live = await probe(uploadId)
    expect(live.status).toBe(200)
    expect(live.body.uploadId).toBe(uploadId)
    // ...and an unknown id is the ROUTE's typed 404, which is what distinguishes
    // a mounted route from an unmounted one at the same status code.
    const unknown = await probe(ABSENT_UPLOAD_ID)
    expect(unknown.status).toBe(404)
    expect(unknown.body).toEqual({ error: 'upload_not_found' })
    registry!.drop(uploadId)
  })
})

describe('contract §2 wire shape', () => {
  it('assembles chunks and publishes through the SAME ingest as /media/file', async () => {
    const payload = Buffer.from('Quarterly brief\nRevenue: 42\nOwner: Miles\n')
    const uploadId = await openUpload(payload.length)

    const first = await putChunk(uploadId, 0, payload.subarray(0, 16))
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ receivedBytes: 16, nextIndex: 1 })

    const mid = await probe(uploadId)
    expect(mid.status).toBe(200)
    expect(mid.body).toEqual({
      uploadId,
      totalBytes: payload.length,
      receivedBytes: 16,
      nextIndex: 1,
      expiresAt: new Date(clockMs + CHUNKED_UPLOAD_TTL_MS).toISOString(),
    })

    const second = await putChunk(uploadId, 1, payload.subarray(16))
    expect(second.body).toEqual({ receivedBytes: payload.length, nextIndex: 2 })

    const done = await finalize(uploadId)
    expect(done.status).toBe(200)
    const attachment = done.body.attachment as { id: string; bytes: number; mime: string; label: string }
    // Same ref shape as /api/media/file, and the label came off the init header.
    expect(attachment.bytes).toBe(payload.length)
    expect(attachment.mime).toBe('text/plain')
    expect(attachment.label).toBe('notes.txt')

    const content = store!.getContent(attachment.id)
    expect(content.status).toBe('ok')
    if (content.status !== 'ok') return
    // Byte-for-byte across two requests: the reassembly is the point.
    expect(readFileSync(content.path)).toEqual(payload)
  })

  it('advertises the same chunkBytes health publishes', async () => {
    const res = await init({ totalBytes: 1024 })
    expect(res.status).toBe(200)
    // The client may read chunk geometry from init OR from health; they cannot
    // be allowed to disagree.
    expect(res.body.chunkBytes).toBe(MEDIA_CHUNK_BYTES)
    expect(res.body.receivedBytes).toBe(0)
    registry!.drop(res.body.uploadId as string)
  })
})

describe('an unknown or wiped uploadId is 404, never a partial success', () => {
  // reconcile() rm -rf's tmp/ on every boot, so a restart legitimately produces
  // this on all three verbs — the client has to be able to start over cleanly.
  it('answers 404 on chunk, probe, and finalize alike', async () => {
    const before = assetIds()
    const chunk = await putChunk(ABSENT_UPLOAD_ID, 0, Buffer.from('x'))
    expect(chunk.status).toBe(404)
    expect(chunk.body).toEqual({ error: 'upload_not_found' })

    expect((await probe(ABSENT_UPLOAD_ID)).status).toBe(404)

    const end = await finalize(ABSENT_UPLOAD_ID)
    expect(end.status).toBe(404)
    expect(end.body).toEqual({ error: 'upload_not_found' })
    expectNoNewAssets(before) // nothing published on the way to that 404
  })

  it('treats a malformed uploadId as unknown rather than reaching the registry', async () => {
    // Raw path segments, because the id IS a path component — including an
    // encoded traversal, which Express decodes into req.params and which the id
    // pattern therefore has to reject on its own.
    for (const segment of ['not-an-id', 'u_short', `u_${'z'.repeat(24)}`, 'u_..%2Fassets', 'u_%2E%2E']) {
      const res = await probe(segment)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'upload_not_found' })
    }
    // A bare '..' never reaches Express at all: the URL layer normalizes the
    // path first, so it resolves to /api/media/ and 404s there with an untyped
    // body. Recorded so a future reader does not read that as a route bug.
    expect((await probe('..')).status).toBe(404)
  })

  it('does not resurrect a finalized upload', async () => {
    const payload = Buffer.from('one shot only\n')
    const uploadId = await openUpload(payload.length)
    await putChunk(uploadId, 0, payload)
    expect((await finalize(uploadId)).status).toBe(200)
    const published = assetIds().length

    // A duplicate finalize must not ingest the same bytes twice.
    const again = await finalize(uploadId)
    expect(again.status).toBe(404)
    expect(assetIds()).toHaveLength(published)
  })
})

describe('uploadId shape', () => {
  it('accepts only ids this server could have minted', () => {
    // Pinned DIRECTLY because the wire cannot distinguish it: a malformed id and
    // a well-formed-but-unknown id both answer 404 upload_not_found, so the route
    // test above still passes with the pattern loosened to /^u_/ — measured, not
    // assumed. This predicate is the only thing keeping a traversal-shaped or
    // oversized segment from being used as a registry key.
    expect(isValidUploadId(`u_${'0'.repeat(24)}`)).toBe(true)
    expect(isValidUploadId(`u_${'a'.repeat(24)}`)).toBe(true)
    for (const bad of [
      `u_${'a'.repeat(23)}`,          // too short
      `u_${'a'.repeat(25)}`,          // too long
      `u_${'A'.repeat(24)}`,          // minting is lower-case hex
      `u_${'z'.repeat(24)}`,          // not hex
      'u_../assets', 'u_..', 'u_',    // path-shaped
      `m_${'a'.repeat(24)}`,          // a MEDIA id is not an upload id
      '', 'not-an-id', null, undefined, 42, {},
    ]) {
      expect(isValidUploadId(bad)).toBe(false)
    }
  })

  it('mints ids that satisfy its own validator', async () => {
    // Round-trip, so a tightened pattern that no longer matches minted ids fails
    // here rather than 404ing every upload in production.
    const uploadId = await openUpload(4)
    expect(isValidUploadId(uploadId)).toBe(true)
    registry!.drop(uploadId)
  })
})

describe('sequential and in-order', () => {
  it('refuses a skipped index with the index it actually wants', async () => {
    const uploadId = await openUpload(8)
    const res = await putChunk(uploadId, 1, Buffer.from('abcd'))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'chunk_out_of_order', expectedIndex: 0 })
    // Rejected BEFORE any write: progress is untouched.
    expect((await probe(uploadId)).body).toMatchObject({ receivedBytes: 0, nextIndex: 0 })
    registry!.drop(uploadId)
  })

  it('refuses a re-send of an already-committed index, and does not double-append', async () => {
    const uploadId = await openUpload(8)
    expect((await putChunk(uploadId, 0, Buffer.from('abcd'))).body).toEqual({ receivedBytes: 4, nextIndex: 1 })

    const repeat = await putChunk(uploadId, 0, Buffer.from('abcd'))
    expect(repeat.status).toBe(409)
    // The 409 carries the recovery information, which is the whole reason a
    // blind append is wrong here: the client cannot know whether its last chunk
    // landed, and 4 duplicated bytes would corrupt the asset silently.
    expect(repeat.body).toEqual({ error: 'chunk_out_of_order', expectedIndex: 1 })
    expect((await probe(uploadId)).body).toMatchObject({ receivedBytes: 4, nextIndex: 1 })
    registry!.drop(uploadId)
  })

  it('refuses a non-numeric index as out-of-order rather than 500ing', async () => {
    const uploadId = await openUpload(8)
    // The last three are the cases the route's DECIMAL-ONLY parse exists for, and
    // they are why it is not redundant with the registry's integer check:
    // Number('0x0'), Number(' 0') and Number('+0') are all exactly 0, so without
    // the regex a hex, whitespace-padded, or signed segment would be silently
    // accepted as chunk 0. The first four are caught downstream either way —
    // measured, so this test reaches the guard it claims to.
    for (const index of ['abc', '-1', '1.5', '1e3', '0x0', '%200', '%2B0']) {
      const res = await putChunk(uploadId, index, Buffer.from('ab'))
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'chunk_out_of_order', expectedIndex: 0 })
    }
    registry!.drop(uploadId)
  })

  it('re-sending the chunk at nextIndex after a failed write is idempotent', async () => {
    // The strong form of §6's idempotency claim. The first attempt at index 1
    // throws mid-write; the counters must NOT advance, so the retry writes at the
    // same offset and the assembled file is exactly right — an open(path,'a')
    // append would have duplicated those bytes.
    let failNextWrite = true
    installRegistry({
      fs: {
        writeAt: (path, bytes, position) => {
          if (failNextWrite && position > 0) {
            failNextWrite = false
            // Write a SHORTER partial first, so the retry has to overwrite real
            // garbage rather than an untouched tail.
            defaultUploadSessionFs.writeAt(path, bytes.subarray(0, 2), position)
            throw new Error('EIO: simulated mid-write failure')
          }
          defaultUploadSessionFs.writeAt(path, bytes, position)
        },
      },
    })
    const payload = Buffer.from('assembled exactly once\n')
    const uploadId = await openUpload(payload.length)
    expect((await putChunk(uploadId, 0, payload.subarray(0, 8))).body)
      .toEqual({ receivedBytes: 8, nextIndex: 1 })

    const failed = await putChunk(uploadId, 1, payload.subarray(8))
    expect(failed.status).toBe(500)
    // Counters frozen at the last COMMITTED chunk.
    expect((await probe(uploadId)).body).toMatchObject({ receivedBytes: 8, nextIndex: 1 })

    const retry = await putChunk(uploadId, 1, payload.subarray(8))
    expect(retry.body).toEqual({ receivedBytes: payload.length, nextIndex: 2 })

    const done = await finalize(uploadId)
    expect(done.status).toBe(200)
    const id = (done.body.attachment as { id: string }).id
    const content = store!.getContent(id)
    expect(content.status).toBe('ok')
    if (content.status !== 'ok') return
    expect(readFileSync(content.path)).toEqual(payload)
  })
})

describe('the ceiling is enforced as bytes accumulate, not only at init', () => {
  it('refuses a declared total over the assembled ceiling', async () => {
    const res = await init({ totalBytes: MAX_CHUNKED_MEDIA_BYTES + 1, mime: 'video/mp4' })
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: 'attachment_too_large', maxBytes: MAX_CHUNKED_MEDIA_BYTES })
    expect(registry!.size()).toBe(0) // no session, no staging file
  })

  it('accepts a declared total exactly AT the ceiling', async () => {
    // Boundary in the other direction: `>` not `>=`, or the advertised
    // chunkedMaxBytes would be one byte more than the server accepts.
    const res = await init({ totalBytes: MAX_CHUNKED_MEDIA_BYTES, mime: 'video/mp4' })
    expect(res.status).toBe(200)
    registry!.drop(res.body.uploadId as string)
  })

  it('rejects a malformed totalBytes instead of calling it too large', async () => {
    for (const totalBytes of [0, -1, 1.5, '10', null, undefined, Number.NaN]) {
      const res = await init({ totalBytes })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_total_bytes' })
    }
    expect(registry!.size()).toBe(0)
  })

  it('fails the upload the moment accumulated bytes exceed the DECLARED total', async () => {
    // totalBytes is a client CLAIM (§6). Trusting it and only checking at
    // finalize would let a client stream unbounded bytes into tmp/.
    const uploadId = await openUpload(10)
    expect((await putChunk(uploadId, 0, Buffer.alloc(6, 0x61))).body)
      .toEqual({ receivedBytes: 6, nextIndex: 1 })

    const over = await putChunk(uploadId, 1, Buffer.alloc(6, 0x62))
    expect(over.status).toBe(413)
    expect(over.body).toEqual({ error: 'attachment_too_large', maxBytes: 10 })
    // Fatal, not repairable: the assembled file can never match the declaration,
    // so the session and its disk go immediately.
    expect((await probe(uploadId)).status).toBe(404)
    expect(tmpEntries()).toEqual([])
  })

  it('accepts the chunk that lands exactly ON the declared total', async () => {
    const uploadId = await openUpload(10)
    await putChunk(uploadId, 0, Buffer.alloc(6, 0x61))
    const exact = await putChunk(uploadId, 1, Buffer.alloc(4, 0x62))
    expect(exact.status).toBe(200)
    expect(exact.body).toEqual({ receivedBytes: 10, nextIndex: 2 })
    registry!.drop(uploadId)
  })

  it('refuses a chunk larger than the advertised chunk size WITHOUT killing the upload', async () => {
    // Repairable: the client can re-send this index at the right size. Tested on
    // the registry because the route's parser is bound at the advertised 8 MiB
    // and pushing 8 MiB through fetch proves nothing this does not.
    const small = installRegistry({ maxChunkBytes: 4 })
    const session = small.create({ totalBytes: 16 })
    expect(() => small.appendChunk(session.uploadId, 0, Buffer.alloc(5, 0x61)))
      .toThrowError(/chunk exceeds 4 byte/)
    // Still alive, still at index 0.
    expect(small.peek(session.uploadId)).toMatchObject({ receivedBytes: 0, nextIndex: 0 })
    const ok = small.appendChunk(session.uploadId, 0, Buffer.alloc(4, 0x61))
    expect(ok.receivedBytes).toBe(4)
    small.drop(session.uploadId)
  })

  it('refuses a chunk BODY over the advertised size while streaming', async () => {
    // Drives the parser directly so the chunk boundaries are ours: the refusal
    // has to land about one chunk past the limit, not after buffering the lot.
    const result = await runChunkParser(
      [Buffer.alloc(32, 0x61), Buffer.alloc(32, 0x62)],
      { maxChunkBytes: 40 },
    )
    expect(result.nexted).toBe(false)
    expect(result.status).toBe(413)
    expect(result.body).toEqual({ error: 'attachment_too_large', maxBytes: 40 })
  })

  it('stops opening new uploads once the concurrent-session bound is reached', async () => {
    // Each live session may hold up to chunkedMaxBytes of staging file, so the
    // count is a disk bound. 503 is §2's init-unavailable code.
    const ids: string[] = []
    for (let i = 0; i < MAX_CONCURRENT_CHUNKED_UPLOADS; i++) {
      const res = await init({ totalBytes: 8 })
      expect(res.status).toBe(200)
      ids.push(res.body.uploadId as string)
    }
    const refused = await init({ totalBytes: 8 })
    expect(refused.status).toBe(503)
    expect(refused.body).toEqual({ error: 'chunked_upload_unavailable' })
    for (const id of ids) registry!.drop(id)
  })
})

describe('finalize re-verifies the assembled file', () => {
  it('reports incomplete_upload with both counts, and keeps the upload alive', async () => {
    const uploadId = await openUpload(20)
    await putChunk(uploadId, 0, Buffer.alloc(8, 0x61))

    const early = await finalize(uploadId)
    expect(early.status).toBe(400)
    expect(early.body).toEqual({ error: 'incomplete_upload', receivedBytes: 8, totalBytes: 20 })
    // "Not done yet" is not a failure: the client keeps sending.
    const resumed = await probe(uploadId)
    expect(resumed.status).toBe(200)
    expect(resumed.body).toMatchObject({ receivedBytes: 8, nextIndex: 1 })
    registry!.drop(uploadId)
  })

  it('refuses to ingest when the staged file no longer matches the counters', async () => {
    // §6: re-verify the ASSEMBLED size at finalize. The counters are ours and the
    // file is the thing being ingested — truncate it behind the server's back
    // and the counters become the untrustworthy half.
    const payload = Buffer.from('truncated behind our back\n')
    const uploadId = await openUpload(payload.length)
    await putChunk(uploadId, 0, payload)
    const stagingPath = registry!.peek(uploadId)!.stagingPath
    const before = assetIds()
    truncateSync(stagingPath, payload.length - 5)

    const res = await finalize(uploadId)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: 'upload_size_mismatch',
      receivedBytes: payload.length - 5,
      totalBytes: payload.length,
    })
    expectNoNewAssets(before) // nothing published from a short body
    expect(existsSync(stagingPath)).toBe(false)
    expect((await probe(uploadId)).status).toBe(404)
  })

  it('leaves no half-published asset when ingest rejects the assembly', async () => {
    // Unsupported format: valid chunk mechanics, invalid media. Ingest is atomic
    // (stage dir then rename), so the failure must publish nothing AND release
    // the staging file — otherwise every rejected 2 GB upload leaks the disk.
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x00, 0x11])
    const res = await init({ totalBytes: payload.length, mime: 'application/x-thing' },
      { 'X-COS-Filename': 'mystery.bin' })
    const uploadId = res.body.uploadId as string
    const stagingPath = registry!.peek(uploadId)!.stagingPath
    const before = assetIds()
    await putChunk(uploadId, 0, payload)

    const done = await finalize(uploadId)
    expect(done.status).toBe(400)
    expect(done.body.error).toBe('unsupported_attachment_format')
    expectNoNewAssets(before)
    expect(existsSync(stagingPath)).toBe(false)
    // The session is spent either way, so the client starts over rather than
    // retrying a finalize that can only fail the same way.
    expect((await finalize(uploadId)).status).toBe(404)
  })
})

describe('expiry', () => {
  it('drops the record and the staging file once expiresAt passes', async () => {
    installRegistry({ ttlMs: 60_000 })
    const uploadId = await openUpload(64)
    await putChunk(uploadId, 0, Buffer.alloc(8, 0x61))
    const stagingPath = registry!.peek(uploadId)!.stagingPath
    expect(existsSync(stagingPath)).toBe(true)

    clockMs += 60_000 // exactly at expiresAt — `<=`, so it is already gone
    const res = await probe(uploadId)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'upload_not_found' })
    expect(existsSync(stagingPath)).toBe(false)
    expect(registry!.size()).toBe(0)
  })

  it('does not expire an upload one millisecond early', async () => {
    installRegistry({ ttlMs: 60_000 })
    const uploadId = await openUpload(64)
    clockMs += 59_999
    expect((await probe(uploadId)).status).toBe(200)
    registry!.drop(uploadId)
  })

  it('refuses a chunk and a finalize for an expired upload', async () => {
    installRegistry({ ttlMs: 1_000 })
    const uploadId = await openUpload(8)
    clockMs += 5_000
    expect((await putChunk(uploadId, 0, Buffer.alloc(4, 0x61))).status).toBe(404)
    expect((await finalize(uploadId)).status).toBe(404)
    expect(tmpEntries()).toEqual([])
  })
})

describe('the chunk body must arrive as bytes', () => {
  it('refuses legibly when an upstream JSON parser already drained the body', async () => {
    // Verified against Express 5 + body-parser 2: a PUT sent as application/json
    // is consumed by the /api/media JSON parser and reaches the route with
    // req.body set and readableEnded true. Attaching 'end' to that finished
    // stream would HANG the request, so this is a 400, not a timeout.
    const uploadId = await openUpload(8)
    const res = await putChunk(uploadId, 0, Buffer.from('{"a":1}'), {
      'Content-Type': 'application/json',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('chunk_bytes_required')
    // The upload is untouched — a mis-typed chunk must not corrupt progress.
    expect((await probe(uploadId)).body).toMatchObject({ receivedBytes: 0, nextIndex: 0 })
    registry!.drop(uploadId)
  })

  it('refuses an empty chunk rather than advancing nextIndex for free', async () => {
    // A zero-byte chunk that advanced the index would let a looping client never
    // finish and never fail.
    const uploadId = await openUpload(8)
    const res = await putChunk(uploadId, 0, Buffer.alloc(0))
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'chunk_bytes_required' })
    expect((await probe(uploadId)).body).toMatchObject({ receivedBytes: 0, nextIndex: 0 })
    registry!.drop(uploadId)
  })

  it('leaves init and finalize on the JSON parser', async () => {
    // The parser is route-level middleware on the PUT, so it cannot see these
    // two. If it ever did, init would read its JSON body as raw bytes.
    const uploadId = await openUpload(4)
    await putChunk(uploadId, 0, Buffer.from('abcd'))
    expect((await finalize(uploadId)).status).toBe(200)
  })
})

/** Drive the chunk parser directly. Chunk boundaries are ours to choose, and the
 *  streaming refusal is unreachable through fetch, which delivers a small body in
 *  one piece. */
function runChunkParser(
  chunks: Buffer[],
  options: { maxChunkBytes?: number } = {},
): Promise<{ status: number; body: Record<string, unknown>; nexted: boolean; bytes: number }> {
  return new Promise((resolve, reject) => {
    const req = new PassThrough() as unknown as Request & PassThrough
    req.method = 'PUT'
    req.header = ((name: string) =>
      (name.toLowerCase() === 'content-type' ? 'application/octet-stream' : undefined)) as Request['header']
    let status = 200
    const res = {
      status(code: number) { status = code; return this },
      json(payload: Record<string, unknown>) { resolve({ status, body: payload, nexted: false, bytes: 0 }); return this },
      once(event: string, listener: () => void) { if (event === 'finish') setImmediate(listener); return this },
    } as unknown as Response
    const next: NextFunction = () => resolve({ status, body: {}, nexted: true, bytes: 0 })
    try {
      createMediaChunkBodyParser(options)(req, res, next)
    } catch (err) {
      reject(err)
      return
    }
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

describe('cancelling an upload releases the slot and the disk immediately', () => {
  // The route had NO server test: the client's coverage uses a stub, so removing the
  // whole route left every suite green. Found by mutation, recorded, then covered.

  it('drops a live session, releases its staging file, and makes it unknown', async () => {
    const { uploadId } = (await init({ totalBytes: MEDIA_CHUNK_BYTES * 2, mime: 'video/mp4' })).body as { uploadId: string }
    await putChunk(uploadId, 0, Buffer.alloc(MEDIA_CHUNK_BYTES, 0x7a))
    expect((await probe(uploadId)).status).toBe(200)

    const res = await cancel(uploadId)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, dropped: true })

    // The slot is genuinely gone, not just marked.
    expect((await probe(uploadId)).status).toBe(404)
    expect((await putChunk(uploadId, 1, Buffer.from('x'))).status).toBe(404)
    expect((await finalize(uploadId)).status).toBe(404)
    // And the staging file with it — this is the disk the 4-hour TTL would have held.
    expect(tmpEntries(), 'staging file must be released, not left for the sweep').toEqual([])
  })

  it('is IDEMPOTENT — an unknown or already-cancelled id is 200, never 404', async () => {
    // The client calls this while already failing. A 404 would invite a retry loop over
    // a request whose only job is to free resources, so success is the honest answer:
    // the resource is not held, which is all the caller needs to be true.
    const first = await cancel(ABSENT_UPLOAD_ID)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true, dropped: false })

    const { uploadId } = (await init({ totalBytes: MEDIA_CHUNK_BYTES, mime: 'video/mp4' })).body as { uploadId: string }
    expect((await cancel(uploadId)).body).toEqual({ ok: true, dropped: true })
    // Second call: same 200, and `dropped` reports it was already gone.
    expect((await cancel(uploadId)).body).toEqual({ ok: true, dropped: false })
  })

  it('still rejects a MALFORMED id — that is a client bug, not a resource', async () => {
    const res = await cancel('not-an-upload-id')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_upload_id' })
  })

  it('frees a concurrency slot, so a cancelled upload does not cost one for 4 hours', async () => {
    // The actual user-visible failure this route prevents: eight give-ups on a flaky
    // link made init answer 503 for up to four hours with no way to clear it.
    const ids: string[] = []
    for (let i = 0; i < MAX_CONCURRENT_CHUNKED_UPLOADS; i++) {
      const res = await init({ totalBytes: MEDIA_CHUNK_BYTES, mime: 'video/mp4' })
      expect(res.status).toBe(200)
      ids.push((res.body as { uploadId: string }).uploadId)
    }
    // Full: the next init is refused.
    expect((await init({ totalBytes: MEDIA_CHUNK_BYTES, mime: 'video/mp4' })).status).toBe(503)

    await cancel(ids[0])

    // One slot back, immediately.
    const after = await init({ totalBytes: MEDIA_CHUNK_BYTES, mime: 'video/mp4' })
    expect(after.status, 'cancelling must free a slot without waiting on the TTL').toBe(200)
  })
})
