// GET /api/meeting/:sessionId/speakers — the read surface behind COS Control's
// naming panel. Executed against a real express server and a real store on disk.
//
// The failure paths carry the weight here. A saved meeting whose sidecar cannot
// be read must NOT report as a meeting where nobody spoke: that reads as "no
// speakers" in the panel and invites the user to name voices that were never
// analysed. It has to say the sidecar is unreadable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root = ''
let server: Server | null = null
let baseUrl = ''

const MONTH = '2026-08'
const STEM = '2026-08-05_Lead_Ops_Review_abc12345'

function seedMeeting(sessionId: string, chunks: unknown, options: { badSidecar?: boolean } = {}): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), '# Lead Ops Review\n\n| **Date** | 2026-08-05 |\n')
  writeFileSync(
    join(dir, `${STEM}.g2-chunks.json`),
    options.badSidecar ? '{"sessionId":"' + sessionId + '","chunks":[{' : JSON.stringify({ sessionId, chunks }),
  )
}

/** A speaker sequence with `runLen` consecutive segments per turn. */
function turns(a: string, b: string, count: number, runLen: number): unknown[] {
  const out: unknown[] = []
  let i = 0
  for (let t = 0; t < count; t++) {
    const who = t % 2 === 0 ? a : b
    for (let r = 0; r < runLen; r++) {
      out.push({
        speaker: who, elapsed: i * 7000, similarity: 0.82,
        text: `${who} raised the Jewel360 pipeline question in segment ${i} at 36 percent`,
      })
      i++
    }
  }
  return out
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU',
    getVocabulary: () => [],
    getOwnerName: () => 'Miles',
    getTranscriptionProfileStatus: () => ({}),
  }))
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingRouter({ store: new MeetingStore(root) }))
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server!.address()
      if (!a || typeof a === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${a.port}`
      resolve()
    })
  })
}

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET' }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cos-mtg-speakers-')) })
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * Real-server integration tests: each starts an express listener, writes files,
 * and makes an HTTP round trip. Vitest's 5s default is not enough under
 * full-suite CPU contention — a sibling integration suite loads a 26 MB ONNX
 * model in the same run — and the resulting failures surface as bare
 * STACK_TRACE_ERROR timeouts on a DIFFERENT test each run, which reads exactly
 * like a real intermittent regression. Measured: 3 flaky runs at the default,
 * 0 across 4 runs at 30s. Set explicitly so a green suite means green.
 */
const HTTP_TEST_TIMEOUT = 30_000

describe('speaker review over HTTP', () => {
  it('returns voices, phrases, and the owner flag for a real conversation', async () => {
    seedMeeting('meeting_1_abc', turns('MU', 'Chris Krubeck', 8, 30))
    await startServer()

    const res = await get('/api/meeting/meeting_1_abc/speakers')
    expect(res.status).toBe(200)
    expect(res.json.attributed).toBe(true)
    expect(res.json.title).toBe('Lead Ops Review')
    expect(res.json.voices).toHaveLength(2)

    const mu = res.json.voices.find((v: any) => v.label === 'MU')
    expect(mu.isOwner).toBe(true)
    expect(mu.reliability).toBe('confident')
    expect(mu.thrashesWith).toEqual([])
    // Phrases are the point of the endpoint — with timestamps, in order.
    expect(mu.phrases.length).toBeGreaterThan(0)
    expect(mu.phrases[0]).toHaveProperty('atMs')
    expect(mu.phrases[0].text).toContain('Jewel360')
  })

  it('flags a thrashing pair as unreliable and names the partner', async () => {
    seedMeeting('meeting_2_abc', turns('Luke H', 'Luke Henry', 24, 3))
    await startServer()
    const res = await get('/api/meeting/meeting_2_abc/speakers')
    expect(res.status).toBe(200)
    for (const v of res.json.voices) {
      expect(v.reliability).toBe('unreliable')
      expect(v.thrashesWith[0].meanRun).toBeLessThan(8)
    }
  })

  it('reports a recovered meeting as unattributed, still with phrases', async () => {
    seedMeeting('meeting_3_abc', turns('Unknown', 'Unknown', 1, 52))
    await startServer()
    const res = await get('/api/meeting/meeting_3_abc/speakers')
    expect(res.status).toBe(200)
    expect(res.json.attributed).toBe(false)
    expect(res.json.voices[0].reliability).toBe('unattributed')
    expect(res.json.voices[0].phrases.length).toBeGreaterThan(0)
  })

  it('honours the phrases count and clamps it', async () => {
    seedMeeting('meeting_4_abc', turns('MU', 'Chris Krubeck', 8, 30))
    await startServer()
    expect((await get('/api/meeting/meeting_4_abc/speakers?phrases=1')).json.voices[0].phrases).toHaveLength(1)
    const clamped = (await get('/api/meeting/meeting_4_abc/speakers?phrases=999')).json.voices[0].phrases
    expect(clamped.length).toBeLessThanOrEqual(6)
  })

  it('a CORRUPT sidecar 404s, because the store matches sessions by reading it', async () => {
    // Documented rather than worked around. findBySessionId parses every sidecar
    // to find the one whose sessionId matches, so a truncated sidecar is
    // unfindable — the lookup fails before this route reads anything. The route
    // keeps its own 422 guard for the narrower case where the file becomes
    // unreadable between the store's read and ours.
    //
    // What matters either way: it does NOT return 200 with an empty voice list,
    // which would invite naming voices that were never analysed.
    seedMeeting('meeting_5_abc', [], { badSidecar: true })
    await startServer()
    const res = await get('/api/meeting/meeting_5_abc/speakers')
    expect(res.status).toBe(404)
    expect(res.json).not.toHaveProperty('voices')
  })

  it('422s when the sidecar holds no chunk array', async () => {
    const dir = join(root, MONTH)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${STEM}.md`), '# Lead Ops Review\n')
    writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify({ sessionId: 'meeting_6_abc' }))
    await startServer()
    const res = await get('/api/meeting/meeting_6_abc/speakers')
    expect(res.status).toBe(422)
    expect(res.json.reason).toBe('sidecar_empty')
  })

  it('404s an unknown session and 400s a malformed id', async () => {
    seedMeeting('meeting_7_abc', turns('MU', 'Chris Krubeck', 8, 30))
    await startServer()
    expect((await get('/api/meeting/meeting_nope/speakers')).status).toBe(404)
    const bad = await get('/api/meeting/..%2F..%2Fetc/speakers')
    expect([400, 404]).toContain(bad.status)
  })

  it('never caches — a name applied elsewhere must not be masked by a stale read', async () => {
    seedMeeting('meeting_8_abc', turns('MU', 'Chris Krubeck', 8, 30))
    await startServer()
    const res = await new Promise<string | undefined>((resolve, reject) => {
      const req = request(`${baseUrl}/api/meeting/meeting_8_abc/speakers`, { method: 'GET' }, r => {
        r.resume(); r.on('end', () => resolve(r.headers['cache-control']))
      })
      req.on('error', reject); req.end()
    })
    expect(res).toContain('no-store')
  })
}, HTTP_TEST_TIMEOUT)

// COS-operations mode. This is the path that actually runs on a COS install, and
// it was missed once already: sessionId was added to MeetingStore.list() while
// the live server serves its list from listCosOperationsMeetings(), so the field
// never appeared and every row was skipped. Same class of miss for the review
// itself, which resolved the standalone copy and would have shown a different
// TITLE than the row the user clicked.
describe('COS operations mode', () => {
  let ops = ''

  function seedOps(domain: string, stem: string, heading: string, sessionId: string, chunks: unknown[]): void {
    const dir = join(ops, domain, 'meetings', MONTH)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${stem}.md`), `# ${heading}\n\n| **Date** | 2026-08-05 |\n`)
    writeFileSync(join(dir, `${stem}.g2-chunks.json`), JSON.stringify({ sessionId, chunks }))
  }

  beforeEach(() => {
    ops = mkdtempSync(join(tmpdir(), 'cos-ops-mtg-'))
    process.env.COS_OPERATIONS_DIR = ops
  })
  afterEach(() => {
    delete process.env.COS_OPERATIONS_DIR
    if (ops) rmSync(ops, { recursive: true, force: true })
  })

  it('resolves a review from the operations tree, not the standalone store', async () => {
    seedOps('personal', '2026-08-05_Family_Dinner_aaa11111', 'Family Dinner And Commonwealth Games',
      'meeting_ops_1', turns('MU', 'Chris Krubeck', 8, 30))
    await startServer()

    const res = await get('/api/meeting/meeting_ops_1/speakers')
    expect(res.status).toBe(200)
    expect(res.json.source).toBe('cos_operations')
    // The TITLE is the point: the operations copy carries the good one.
    expect(res.json.title).toBe('Family Dinner And Commonwealth Games')
    expect(res.json.domain).toBe('personal')
    expect(res.json.voices).toHaveLength(2)
  })

  it('prefers operations even when the standalone store holds the same session', async () => {
    // Both trees really do hold every G2 save, under different names. Resolving
    // the store first shows one title on the list row and another in the panel.
    seedMeeting('meeting_both_1', turns('MU', 'Chris Krubeck', 8, 30))
    seedOps('personal', '2026-08-05_Titled_Copy_bbb22222', 'The Titled Copy',
      'meeting_both_1', turns('MU', 'Chris Krubeck', 8, 30))
    await startServer()

    const res = await get('/api/meeting/meeting_both_1/speakers')
    expect(res.status).toBe(200)
    expect(res.json.source).toBe('cos_operations')
    expect(res.json.title).toBe('The Titled Copy')
  })

  it('searches every domain, not just personal', async () => {
    seedOps('quilt', '2026-08-05_Lead_Ops_ccc33333', 'Lead Ops Review',
      'meeting_quilt_1', turns('MU', 'Graham Hoffman', 8, 30))
    await startServer()
    const res = await get('/api/meeting/meeting_quilt_1/speakers')
    expect(res.status).toBe(200)
    expect(res.json.domain).toBe('quilt')
  })

  it('404s a session that is in neither tree', async () => {
    seedOps('personal', '2026-08-05_Something_ddd44444', 'Something',
      'meeting_ops_2', turns('MU', 'Chris Krubeck', 8, 30))
    await startServer()
    expect((await get('/api/meeting/meeting_absent/speakers')).status).toBe(404)
  })
}, HTTP_TEST_TIMEOUT)
