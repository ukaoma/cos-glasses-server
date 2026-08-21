// POST /api/meeting/:sessionId/relabel — correcting who a voice was, in ONE
// meeting. Driven over real HTTP against real files, and every assertion about
// what changed is made by READING THE FILES BACK, not by trusting the response.
//
// The properties that carry the weight:
//   * Nothing mutates without an explicit confirm.
//   * The ledger intent lands BEFORE any file is touched, so a crash is visible.
//   * A ledger that cannot be written aborts with the files untouched.
//   * A partial relabel never touches the markdown transcript, because turn
//     indices do not correspond to chunk indices.
//   * Narrative prose is never rewritten.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// The REAL encoder, so the fixture below is a byte-accurate chunk-embedding file
// rather than a shape this suite invented. Pure — no data-dir dependency.
import { encodeEmbedding } from '../lib/chunk-embedding-store.js'

let root = ''
let dataDir = ''
let server: Server | null = null
let baseUrl = ''

const MONTH = '2026-08'
const STEM = '2026-08-05_Lead_Ops_Review_abc12345'

const SCRIBE = `# Lead Ops Review

| Field | Value |
|-------|-------|
| **Date** | 2026-08-05 |

## Attendees

- Luke H
- MU

## Summary

Luke H walked the pipeline while MU pushed on timing. Luke owns the follow-up.

## Transcript

[Luke H]: The Jewel360 pipeline is at thirty six percent.
[MU]: Let us take that offline, Luke H can own it.
[Luke H]: Agreed on the follow-up.
`

interface SeedOptions {
  scribe?: string
  /**
   * RAW capture index for each compacted chunk, which is what makes a fixture
   * able to catch the 6.27.10 bug at all.
   *
   * A real sidecar's `chunks` array is COMPACTED — transcribe-stream's
   * getSessionChunks filters to entries carrying text — while the audio and the
   * embedding store are keyed on the raw capture index, written for every chunk
   * with 2s+ of audio before ASR is known. `chunkEntries` is the bridge, and it
   * is emitted here with text-less rows filling the gaps exactly as a live
   * capture produces them. 73 of 74 live sessions have gaps.
   *
   * Omitted = no `chunkEntries` at all, i.e. a pre-2026-07 capture. That is a
   * meaningful case in its own right: enrolment must REFUSE, not guess.
   */
  rawIndices?: number[]
  /**
   * Stamp `chunkIndex` onto the CHUNK ROWS while emitting NO `chunkEntries`.
   *
   * A sidecar that asserts its own raw indices without the array that
   * establishes them. Nothing in the pipeline writes this today, which is the
   * point: it is the one shape where the per-element `chunkIndex` check cannot
   * catch a missing mapping, so it is what makes the reference-identity refusal
   * reachable and therefore testable.
   */
  selfClaimedChunkIndices?: number[]
  /** Meeting start, epoch ms. Relative to now in enrolment fixtures, because the
   *  14-day embedding TTL is read against it and a hardcoded date would make
   *  those tests change verdict on a calendar boundary. */
  startTime?: number
}

function seed(sessionId: string, labels: string[], opts: SeedOptions = {}): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), opts.scribe ?? SCRIBE)
  const chunks = labels.map((speaker, i) => ({
    text: `segment ${i} about the Jewel360 pipeline at thirty six percent`,
    speaker, elapsed: i * 7000, similarity: 0.82,
    words: [{ word: ' segment', start: 0, end: 0.4, probability: 0.9 }],
    ...(opts.selfClaimedChunkIndices ? { chunkIndex: opts.selfClaimedChunkIndices[i] } : {}),
  }))

  let chunkEntries: unknown[] | undefined
  if (opts.rawIndices) {
    if (opts.rawIndices.length !== labels.length) throw new Error('rawIndices must be one per chunk')
    const byRaw = new Map(opts.rawIndices.map((raw, position) => [raw, position]))
    chunkEntries = []
    for (let raw = 0; raw <= Math.max(...opts.rawIndices); raw++) {
      const position = byRaw.get(raw)
      chunkEntries.push(position === undefined
        // A received chunk that produced no text: it has a WAV and an embedding,
        // and it is why position stops equalling raw index.
        ? { chunkIndex: raw, chunk: { text: '', speaker: 'Ext', elapsed: raw * 2000, similarity: 0 } }
        : { chunkIndex: raw, chunk: chunks[position] })
    }
  }

  writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify({
    schemaVersion: 2,
    sessionId,
    startTime: opts.startTime ?? 1786027607017,
    durationMs: 807222,
    speakers: [...new Set(labels)],
    chunks,
    ...(chunkEntries ? { chunkEntries } : {}),
  }, null, 2))
}

const EMBEDDING_DIM = 192   // EXPECTED_EMBEDDING_DIM — the store rejects any other length

/**
 * A 192-float voiceprint on one of two orthogonal subspaces, carrying its raw
 * chunk index in the last component.
 *
 * The marker is how every assertion below identifies WHICH chunk's audio was
 * enrolled, which is the one thing the 6.27.10 tests could not see. Same-axis
 * vectors sit at cosine ~1.0 (one voice), cross-axis at ~0.0 (two people).
 */
function voiceprint(marker: number, axis: 'a' | 'b' = 'a'): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM)
  const start = axis === 'a' ? 0 : 96
  for (let k = start; k < start + 95; k++) v[k] = 100
  v[EMBEDDING_DIM - 1] = marker
  return v
}

/** Write a real chunk-embedding JSONL for the REAL store to read back. Only one
 *  seam in the enrolment join is faked (enrollEmbedding, to observe writes); the
 *  index side is genuine, because faking both is how the bug shipped. */
function writeChunkEmbeddings(
  sessionId: string,
  rows: Array<{ i: number; speaker?: string; axis?: 'a' | 'b' }>,
): void {
  const dir = join(dataDir, 'chunk-embeddings')
  mkdirSync(dir, { recursive: true })
  const lines = rows.map(r => {
    const embedding = voiceprint(r.i, r.axis ?? 'a')
    return JSON.stringify({
      i: r.i,
      speaker: r.speaker ?? 'Ext',
      similarity: 0.41,
      dim: embedding.length,
      v: encodeEmbedding(embedding),
    })
  })
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
}

/** Seed voice-profiles.json so a name already exists. */
function seedVoiceProfile(name: string): void {
  writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({
    profiles: [{
      name,
      embeddings: [Array.from(voiceprint(900))],
      sources: ['fireflies'],
    }],
  }))
}

function sidecarNow(): { speakers: string[]; labels: string[]; raw: string } {
  const raw = readFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), 'utf-8')
  const doc = JSON.parse(raw)
  return { speakers: doc.speakers, labels: doc.chunks.map((c: { speaker: string }) => c.speaker), raw }
}
const scribeNow = (): string => readFileSync(join(root, MONTH, `${STEM}.md`), 'utf-8')
function ledgerNow(sessionId: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(dataDir, 'meeting-corrections', `${sessionId}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return [] }
}

/** Every enrolment write, with the RAW CHUNK INDEX recovered from the vector's
 *  marker component — the assertion the 6.27.10 suite structurally could not make. */
const enrolCalls: Array<{ name: string; source: string; marker: number }> = []
/** 1-based call number on which the voice store should throw. 0 = never. */
let enrolThrowsOnCall = 0
/** Stands in for `extractor && manager`, i.e. is the 26 MB ONNX model loaded. */
let embeddingRuntimeAvailable = true

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU',
    getVocabulary: () => [],
    getOwnerName: () => 'Miles',
    getTranscriptionProfileStatus: () => ({}),
  }))
  // ONE seam, not two.
  //
  // 6.27.10 mocked BOTH `chunk-embedding-store` AND `speaker-embeddings`, so the
  // JOIN between them — compacted sidecar position against raw capture index —
  // was never executed by any test, and the fixture's 3 gapless chunks made
  // position equal raw index anyway. The suite stayed green while the route
  // enrolled 73 of 103 rows belonging to other people.
  //
  // So the chunk-embedding store is now REAL: the tests write a genuine JSONL
  // under COS_DATA_DIR and the route reads it back through the real decoder and
  // the real index filter. Only `enrollEmbedding` is replaced, because a real one
  // needs the ONNX runtime this suite does not have — and it is replaced by a
  // RECORDER that captures which vector arrived, so a wrong join is visible.
  enrolCalls.length = 0
  enrolThrowsOnCall = 0
  embeddingRuntimeAvailable = true
  vi.doMock('../lib/speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/speaker-embeddings.js')
    return {
      ...actual,
      isEmbeddingAvailable: () => embeddingRuntimeAvailable,
      enrollEmbedding: (name: string, e: Float32Array, source: string) => {
        enrolCalls.push({ name, source, marker: e[e.length - 1] })
        if (enrolThrowsOnCall > 0 && enrolCalls.length === enrolThrowsOnCall) {
          throw new Error('voice profile store refused the write')
        }
        return { success: true, dim: e.length }
      },
    }
  })
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

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-mtg-relabel-'))
  dataDir = mkdtempSync(join(tmpdir(), 'cos-mtg-relabel-data-'))
  process.env.COS_DATA_DIR = dataDir
})
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  delete process.env.COS_DATA_DIR
  for (const d of [root, dataDir]) {
    if (d) { try { chmodSync(join(d, 'meeting-corrections'), 0o700) } catch { /* not present */ } rmSync(d, { recursive: true, force: true }) }
  }
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

describe('nothing changes without confirmation', () => {
  it('previews and refuses with 400 when confirm is absent', async () => {
    seed('meeting_c1', ['Luke H', 'MU', 'Luke H'])
    await startServer()

    const res = await post('/api/meeting/meeting_c1/relabel', { from: 'Luke H', to: 'Luke Henry' })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('confirmation_required')
    expect(res.json.chunks).toEqual([0, 2])
    expect(res.json.surfaces).toEqual({ sidecar: 2, attendees: 1, transcript: 2 })

    // The files are untouched — this is the assertion that matters.
    expect(sidecarNow().labels).toEqual(['Luke H', 'MU', 'Luke H'])
    expect(scribeNow()).toBe(SCRIBE)
    expect(ledgerNow('meeting_c1')).toEqual([])
  })

  it('previews with 200 on an explicit dryRun and still changes nothing', async () => {
    seed('meeting_c2', ['Luke H', 'MU'])
    await startServer()

    const res = await post('/api/meeting/meeting_c2/relabel', { from: 'Luke H', to: 'Luke Henry', dryRun: true })
    expect(res.status).toBe(200)
    expect(res.json.error).toBeUndefined()
    expect(res.json.surfaces.sidecar).toBe(1)
    expect(sidecarNow().labels).toEqual(['Luke H', 'MU'])
    expect(ledgerNow('meeting_c2')).toEqual([])
  })

  it('warns in the preview that the summary will still name the old speaker', async () => {
    seed('meeting_c3', ['Luke H'])
    await startServer()

    const res = await post('/api/meeting/meeting_c3/relabel', { from: 'Luke H', to: 'Luke Henry' })
    expect(res.json.proseStale).toBe(true)
    expect(res.json.proseHits).toContain('Luke')
    // The human has to be told BEFORE confirming, because this is the part the
    // system refuses to fix for them.
    expect(res.json.message).toContain('NOT rewritten')
    expect(res.json.message).toContain('first name')
  })
}, HTTP_TEST_TIMEOUT)

describe('applying a full-label correction', () => {
  it('rewrites the sidecar, the attendee line and every transcript turn', async () => {
    seed('meeting_a1', ['Luke H', 'MU', 'Luke H'])
    await startServer()

    const res = await post('/api/meeting/meeting_a1/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)

    const after = sidecarNow()
    expect(after.labels).toEqual(['Luke Henry', 'MU', 'Luke Henry'])
    expect(after.speakers).toEqual(['Luke Henry', 'MU'])
    expect(after.raw.endsWith('}\n')).toBe(true)          // pipeline write format kept

    const md = scribeNow()
    expect(md).toContain('- Luke Henry\n')
    expect(md).not.toContain('- Luke H\n')
    expect(md).toContain('[Luke Henry]: The Jewel360 pipeline')
    expect(md).toContain('[Luke Henry]: Agreed on the follow-up.')
  })

  it('leaves the summary and the spoken name alone', async () => {
    seed('meeting_a2', ['Luke H'])
    await startServer()
    await post('/api/meeting/meeting_a2/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })

    const md = scribeNow()
    expect(md).toContain('Luke H walked the pipeline')          // prose untouched
    expect(md).toContain('Luke owns the follow-up.')            // bare first name untouched
    expect(md).toContain('Luke H can own it.')                  // spoken quote untouched
  })

  it('closes the ledger with an applied row carrying the surface counts', async () => {
    seed('meeting_a3', ['Luke H', 'MU', 'Luke H'])
    await startServer()
    const res = await post('/api/meeting/meeting_a3/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })

    const rows = ledgerNow('meeting_a3')
    expect(rows.map(r => r.phase)).toEqual(['intent', 'applied'])
    expect(rows[0].id).toBe(rows[1].id)
    expect(rows[0].id).toBe(res.json.correctionId)
    expect(rows[1]).toMatchObject({
      from: 'Luke H', to: 'Luke Henry', chunks: [0, 2], scope: 'meeting',
      surfaces: { sidecar: 2, attendees: 1, transcript: 2 }, proseStale: true,
    })
  })

  it('records the exact chunk indices, which is what piece 3 will train on', async () => {
    seed('meeting_a4', ['MU', 'Luke H', 'MU', 'Luke H', 'Luke H'])
    await startServer()
    await post('/api/meeting/meeting_a4/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(ledgerNow('meeting_a4')[1].chunks).toEqual([1, 3, 4])
  })
}, HTTP_TEST_TIMEOUT)

describe('applying a PARTIAL correction', () => {
  it('changes only the named chunks and refuses to touch the markdown', async () => {
    seed('meeting_p1', ['Luke H', 'MU', 'Luke H', 'Luke H'])
    await startServer()

    const res = await post('/api/meeting/meeting_p1/relabel', {
      from: 'Luke H', to: 'Luke Henry', chunks: [0, 2], confirm: true,
    })
    expect(res.status).toBe(200)
    expect(res.json.partial).toBe(true)
    expect(res.json.remainingWithFrom).toBe(1)
    expect(res.json.surfaces).toEqual({ sidecar: 2, attendees: 0, transcript: 0 })
    // The reason is reported rather than left as silence.
    expect(res.json.markdownSkipped).toContain('cannot be mapped to chunk indices')

    expect(sidecarNow().labels).toEqual(['Luke Henry', 'MU', 'Luke Henry', 'Luke H'])
    // Untouched: relabelling by label here would rewrite turns the human never
    // selected, since 3 chunks became 3 markdown turns by a different pass.
    expect(scribeNow()).toBe(SCRIBE)
  })

  it('keeps both names in the sidecar speakers list', async () => {
    seed('meeting_p2', ['Luke H', 'Luke H'])
    await startServer()
    await post('/api/meeting/meeting_p2/relabel', { from: 'Luke H', to: 'Luke Henry', chunks: [0], confirm: true })
    // Both are genuinely attributed segments now.
    expect(sidecarNow().speakers).toEqual(['Luke H', 'Luke Henry'])
  })

  it('refuses when a named chunk does not carry the old label', async () => {
    seed('meeting_p3', ['Luke H', 'MU'])
    await startServer()

    const res = await post('/api/meeting/meeting_p3/relabel', {
      from: 'Luke H', to: 'Luke Henry', chunks: [0, 1], confirm: true,
    })
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('do not carry "Luke H"')
    expect(sidecarNow().labels).toEqual(['Luke H', 'MU'])
    expect(ledgerNow('meeting_p3')).toEqual([])   // rejected before any intent
  })

  it('rejects a non-integer chunk list rather than silently filtering it', async () => {
    seed('meeting_p4', ['Luke H'])
    await startServer()
    const res = await post('/api/meeting/meeting_p4/relabel', {
      from: 'Luke H', to: 'Luke Henry', chunks: [0, 'two', -1], confirm: true,
    })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('invalid_chunks')
  })
}, HTTP_TEST_TIMEOUT)

describe('the ledger goes down first', () => {
  it('aborts with the files untouched when the ledger cannot be written', async () => {
    // An unrecorded mutation is the precise failure the ledger exists to
    // prevent, so an unwritable ledger must stop the correction — not proceed
    // and hope.
    seed('meeting_l1', ['Luke H', 'MU'])
    await startServer()
    writeFileSync(join(dataDir, 'meeting-corrections'), 'a file where the directory goes')

    const res = await post('/api/meeting/meeting_l1/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(500)
    expect(res.json.reason).toBe('ledger_unwritable')
    expect(res.json.error).toContain('nothing was changed')
    expect(sidecarNow().labels).toEqual(['Luke H', 'MU'])
    expect(scribeNow()).toBe(SCRIBE)
  })

  it('refuses a new correction while an earlier one never completed', async () => {
    seed('meeting_l2', ['Luke H', 'MU'])
    await startServer()
    // Exactly what a process dying mid-rewrite leaves behind.
    mkdirSync(join(dataDir, 'meeting-corrections'), { recursive: true })
    writeFileSync(join(dataDir, 'meeting-corrections', 'meeting_l2.jsonl'),
      JSON.stringify({ id: 'died', phase: 'intent', at: '2026-08-06T10:00:00.000Z', from: 'Ext', to: 'Luke H', chunks: [1], scope: 'meeting' }) + '\n')

    const res = await post('/api/meeting/meeting_l2/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('correction_pending')
    expect(res.json.pending[0].id).toBe('died')
    expect(sidecarNow().labels).toEqual(['Luke H', 'MU'])
  })

  it('proceeds past a pending correction only with force', async () => {
    seed('meeting_l3', ['Luke H', 'MU'])
    await startServer()
    mkdirSync(join(dataDir, 'meeting-corrections'), { recursive: true })
    writeFileSync(join(dataDir, 'meeting-corrections', 'meeting_l3.jsonl'),
      JSON.stringify({ id: 'died', phase: 'intent', at: '2026-08-06T10:00:00.000Z', from: 'Ext', to: 'X', chunks: [], scope: 'meeting' }) + '\n')

    const res = await post('/api/meeting/meeting_l3/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true, force: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels).toEqual(['Luke Henry', 'MU'])
    // The stalled row is preserved, not tidied away — it is still evidence.
    expect(ledgerNow('meeting_l3').filter(r => r.id === 'died')).toHaveLength(1)
  })

  it('does not block on a correction that closed as FAILED', async () => {
    seed('meeting_l4', ['Luke H', 'MU'])
    await startServer()
    mkdirSync(join(dataDir, 'meeting-corrections'), { recursive: true })
    const base = { at: '2026-08-06T10:00:00.000Z', from: 'Ext', to: 'X', chunks: [], scope: 'meeting' }
    writeFileSync(join(dataDir, 'meeting-corrections', 'meeting_l4.jsonl'),
      JSON.stringify({ id: 'nope', phase: 'intent', ...base }) + '\n'
      + JSON.stringify({ id: 'nope', phase: 'failed', ...base, error: 'disk full' }) + '\n')

    // A known failure is a closed outcome. Only an unclosed intent means the
    // files may be half-written.
    const res = await post('/api/meeting/meeting_l4/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(200)
  })
}, HTTP_TEST_TIMEOUT)

describe('rejecting bad input', () => {
  it.each([
    ['a label with a bracket that would break the transcript format', { from: 'Luke H', to: 'Bad]: Name' }, 400, 'invalid_label'],
    ['an empty target label', { from: 'Luke H', to: '' }, 400, 'invalid_label'],
    ['a no-op relabel', { from: 'Luke H', to: 'Luke H' }, 400, 'noop_relabel'],
  ])('rejects %s', async (_name, body, status, reason) => {
    seed('meeting_v1', ['Luke H'])
    await startServer()
    const res = await post('/api/meeting/meeting_v1/relabel', { ...body, confirm: true })
    expect(res.status).toBe(status)
    expect(res.json.reason).toBe(reason)
    expect(sidecarNow().labels).toEqual(['Luke H'])
  })

  it('404s an unknown session', async () => {
    seed('meeting_v2', ['Luke H'])
    await startServer()
    const res = await post('/api/meeting/meeting_nothere/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(404)
    expect(res.json.reason).toBe('meeting_not_found')
  })

  it('400s an invalid session id without touching the filesystem', async () => {
    seed('meeting_v3', ['Luke H'])
    await startServer()
    const res = await post('/api/meeting/..%2F..%2Fetc/relabel', { from: 'a', to: 'b', confirm: true })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('invalid_session_id')
  })

  it('422s when the label is absent from the meeting', async () => {
    seed('meeting_v4', ['MU'])
    await startServer()
    const res = await post('/api/meeting/meeting_v4/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('no chunk carries')
    expect(ledgerNow('meeting_v4')).toEqual([])
  })
}, HTTP_TEST_TIMEOUT)

describe('correcting an unidentified voice', () => {
  it('names Ext, the case with no other route to a name', async () => {
    seed('meeting_e1', ['Ext', 'MU', 'Ext'], {
      scribe: SCRIBE.replace(/Luke H/g, 'Ext').replace('- Ext', '- Ext'),
    })
    await startServer()

    const res = await post('/api/meeting/meeting_e1/relabel', { from: 'Ext', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels).toEqual(['Luke Henry', 'MU', 'Luke Henry'])
    expect(ledgerNow('meeting_e1')[1]).toMatchObject({ from: 'Ext', to: 'Luke Henry' })
  })

  it('does not enrol a placeholder onto a placeholder', async () => {
    seed('meeting_pp', ['Ext', 'MU', 'Ext'], { rawIndices: [0, 1, 2] })
    writeChunkEmbeddings('meeting_pp', [{ i: 0 }, { i: 1 }, { i: 2 }])
    await startServer()
    const res = await post('/api/meeting/meeting_pp/relabel',
      { from: 'Ext', to: 'Unidentified 2', confirm: true })
    expect(res.status).toBe(200)
    expect(enrolCalls).toEqual([])
    expect(res.json.enrolment.attempted).toBe(0)
  })
}, HTTP_TEST_TIMEOUT)

// ── Enrolment: naming a placeholder is a FIRST TRAINING RUN ────────────────
//
// Relabel used to be text-only. Saving "Kirstyn Blum" over 109 segments labelled
// one meeting and taught the system nothing — she never appeared in
// /api/voice/profiles, the panel still offered her as `new name` inside the SAME
// meeting, and no later meeting could match her. Verified live 2026-08-13: 70 and
// 112 occurrences across two sidecars against 77 profiles and no Kirstyn.
//
// 6.27.10 fixed that and was reverted the same night for joining COMPACTED
// SIDECAR POSITIONS against RAW CAPTURE INDICES. Every fixture in this block is
// therefore GAPPED — positions 0-4 mapping to raw indices 3, 5, 8, 13, 21 — and
// every assertion recovers the raw index from the enrolled vector itself. A
// position-based join returns rows too; only the marker says whose they were.
describe('enrolling a named voice', () => {
  /** Positions 0..4 -> raw capture indices. Chosen DISJOINT from the positions
   *  they sit at, so a position-based join cannot coincidentally look right. */
  const RAW = [3, 5, 8, 13, 21]
  const ONE_HOUR_AGO = (): number => Date.now() - 3_600_000

  /** Ext at positions 0, 2, 4 -> raw 3, 8, 21. MU holds 1 and 3. */
  const EXT_MU = ['Ext', 'MU', 'Ext', 'MU', 'Ext']

  /** Embeddings for every raw index a correct OR an incorrect join could reach.
   *  Includes 0, 2 and 4 — the POSITIONS — so the buggy path finds real rows and
   *  the test fails on WHOSE they are, not on their absence. Raw 2 is deliberately
   *  the owner: the incident wrote 22 chunks of MU into a stranger's profile. */
  const ALL_ROWS = [
    { i: 0, speaker: 'Vikas' }, { i: 1, speaker: 'Vishnu' }, { i: 2, speaker: 'MU' },
    { i: 3, speaker: 'Ext' }, { i: 4, speaker: 'Niranjan' }, { i: 5, speaker: 'MU' },
    { i: 8, speaker: 'Ext' }, { i: 13, speaker: 'MU' }, { i: 21, speaker: 'Ext' },
  ]

  it('enrols the RAW-index embeddings, never the sidecar positions', async () => {
    seed('meeting_gap', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_gap', ALL_ROWS)
    await startServer()

    const res = await post('/api/meeting/meeting_gap/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.status).toBe(200)

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR. Changed positions are [0, 2, 4];
    // the embeddings that must be enrolled are raw [3, 8, 21]. Reverting the
    // mapping to positions yields [0, 2, 4] here and fails.
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([3, 8, 21])
    expect(enrolCalls.map(c => c.marker)).not.toContain(2)   // the device owner
    expect(enrolCalls.every(c => c.name === 'Kirstyn Blum')).toBe(true)

    expect(res.json.enrolment).toEqual({
      enrolled: 3, attempted: 3, created: true, clusterSkipped: 0, skipped: null,
    })
    expect(res.json.enrolledEmbeddings).toBe(3)
    expect(sidecarNow().labels).toEqual(['Kirstyn Blum', 'MU', 'Kirstyn Blum', 'MU', 'Kirstyn Blum'])
  })

  it('stamps correction:<sessionId>, which is what makes the samples retractable', async () => {
    // A bare tag breaks four things at once: isSampleFromSession accepts only
    // auto:/correction:/g2-training:, so "Not in this meeting" retracts NOTHING;
    // untraceableSampleCount counts it untraceable; provenanceTier drops to
    // 'unknown', below Fireflies metadata for eviction; and isCorrection() is a
    // startsWith('correction') test, so the quota never protects it.
    seed('meeting_src', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_src', ALL_ROWS)
    await startServer()

    await post('/api/meeting/meeting_src/relabel', { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(enrolCalls.length).toBeGreaterThan(0)
    expect(new Set(enrolCalls.map(c => c.source))).toEqual(new Set(['correction:meeting_src']))

    const { isSampleFromSession } = await import('../lib/training-audio-provenance.js')
    const { provenanceTier, isCorrection } = await import('../lib/embedding-eviction.js')
    for (const call of enrolCalls) {
      expect(isSampleFromSession(call.source, 'meeting_src')).toBe(true)
      expect(provenanceTier(call.source)).toBe('human')
      expect(isCorrection(call.source)).toBe(true)
    }
  })

  it('REFUSES rather than guessing when the sidecar carries no chunkEntries', async () => {
    // A pre-2026-07 capture. attachRawChunkIndices signals this by returning the
    // chunks unchanged, which is precisely the case 6.27.10 treated as success.
    // Falling back to positions here is the bug, so refusal is the contract.
    seed('meeting_nomap', EXT_MU, { startTime: ONE_HOUR_AGO() })       // no rawIndices
    writeChunkEmbeddings('meeting_nomap', ALL_ROWS)
    await startServer()

    const res = await post('/api/meeting/meeting_nomap/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.status).toBe(200)
    expect(enrolCalls).toEqual([])
    expect(res.json.enrolment).toEqual({
      enrolled: 0, attempted: 0, created: false, clusterSkipped: 0, skipped: 'no_index_mapping',
    })
    // The rename the user asked for still landed. Refusing to TRAIN is not
    // refusing to RELABEL.
    expect(sidecarNow().labels).toEqual(['Kirstyn Blum', 'MU', 'Kirstyn Blum', 'MU', 'Kirstyn Blum'])
  })

  it('REFUSES a chunkIndex the chunk claims for itself, with no chunkEntries to back it', async () => {
    // The ONLY shape in which the reference-identity refusal is load-bearing, and
    // it was added after a mutation run: deleting `if (withRaw === chunks) return
    // null` SURVIVED every other test here, because when chunkEntries is absent
    // the chunks carry no chunkIndex and the per-element check refuses anyway.
    // That made the identity check look like dead code. It is not — it is the
    // only thing standing between "a mapping was ESTABLISHED from chunkEntries"
    // and "a sidecar asserted some numbers about itself".
    //
    // attachRawChunkIndices returns the array UNCHANGED here, meaning no mapping
    // was established. Trusting the numbers anyway is the 6.27.10 class of error
    // one layer down, so this fails closed.
    seed('meeting_selfclaim', EXT_MU, { selfClaimedChunkIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_selfclaim', ALL_ROWS)
    await startServer()

    const res = await post('/api/meeting/meeting_selfclaim/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment.skipped).toBe('no_index_mapping')
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[0]).toBe('Kirstyn Blum')
  })

  it('REFUSES when chunkEntries disagrees with the compacted count', async () => {
    // The other half of attachRawChunkIndices' bail: a shifted mapping is worse
    // than none, because it points at a neighbouring speaker and looks fine.
    seed('meeting_skew', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    const path = join(root, MONTH, `${STEM}.g2-chunks.json`)
    const doc = JSON.parse(readFileSync(path, 'utf-8'))
    doc.chunkEntries = doc.chunkEntries.slice(0, -1)   // drop the last text-bearing row
    writeFileSync(path, JSON.stringify(doc, null, 2))
    writeChunkEmbeddings('meeting_skew', ALL_ROWS)
    await startServer()

    const res = await post('/api/meeting/meeting_skew/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.json.enrolment.skipped).toBe('no_index_mapping')
    expect(enrolCalls).toEqual([])
  })

  it('reports no_embeddings when the store holds nothing for this meeting', async () => {
    // Meeting predates the embedding store. The rename must still apply, and the
    // reason must be NAMED — a bare `enrolled: 0` is indistinguishable from a
    // missing ONNX model or a disabled feature.
    seed('meeting_none', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    await startServer()                                  // no embedding file at all

    const res = await post('/api/meeting/meeting_none/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolment).toEqual({
      enrolled: 0, attempted: 0, created: false, clusterSkipped: 0, skipped: 'no_embeddings',
    })
    expect(enrolCalls).toEqual([])
    expect(sidecarNow().labels[0]).toBe('Kirstyn Blum')
  })

  it('reports no_embeddings when rows exist but none cover the relabelled chunks', async () => {
    // Present-but-irrelevant, which the `missing` flag cannot express.
    seed('meeting_other', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_other', [{ i: 1 }, { i: 5 }, { i: 13 }])   // MU's chunks only
    await startServer()

    const res = await post('/api/meeting/meeting_other/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.json.enrolment.skipped).toBe('no_embeddings')
    expect(enrolCalls).toEqual([])
  })

  it('distinguishes an EXPIRED meeting from one that never had embeddings', async () => {
    // 14-day TTL. "You corrected this too late" and "this could never train" are
    // different answers, and the sweep leaves no trace to tell them apart — the
    // meeting's own start time is the only evidence.
    seed('meeting_old', EXT_MU, { rawIndices: RAW, startTime: Date.now() - 30 * 86_400_000 })
    await startServer()

    const res = await post('/api/meeting/meeting_old/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.json.enrolment.skipped).toBe('expired')
  })

  it('reports disabled when COS_CHUNK_EMBEDDINGS=0', async () => {
    seed('meeting_off', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_off', ALL_ROWS)
    process.env.COS_CHUNK_EMBEDDINGS = '0'
    try {
      await startServer()
      const res = await post('/api/meeting/meeting_off/relabel',
        { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
      expect(res.json.enrolment.skipped).toBe('disabled')
      expect(enrolCalls).toEqual([])
    } finally {
      delete process.env.COS_CHUNK_EMBEDDINGS
    }
  })

  it('reports store_unavailable when the voiceprint model is not loaded', async () => {
    // The ~26 MB 3dspeaker model is .npmignore'd and a managed cutover has
    // stranded it before. Without it every enrollEmbedding returns success:false,
    // so looping twenty times to report a bare zero would hide the real cause.
    seed('meeting_nomodel', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_nomodel', ALL_ROWS)
    await startServer()
    embeddingRuntimeAvailable = false

    const res = await post('/api/meeting/meeting_nomodel/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.json.enrolment.skipped).toBe('store_unavailable')
    expect(enrolCalls).toEqual([])
  })

  it('keeps the rename and the partial count when the voice store THROWS', async () => {
    // Genuinely throwing, not a pure mock returning success:false. The 6.27.10
    // suite could not throw at all, so its catch block had zero coverage while
    // the changelog claimed both directions were mutation-checked.
    seed('meeting_throws', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_throws', ALL_ROWS)
    await startServer()
    enrolThrowsOnCall = 2                        // one lands, then the store refuses

    const res = await post('/api/meeting/meeting_throws/relabel',
      { from: 'Ext', to: 'New Person', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    // Enrolment is a bonus on top of a rename already durable on disk.
    expect(sidecarNow().labels).toEqual(['New Person', 'MU', 'New Person', 'MU', 'New Person'])
    expect(res.json.enrolment).toMatchObject({
      enrolled: 1, attempted: 3, clusterSkipped: 0, skipped: 'store_unavailable',
    })
    expect(ledgerNow('meeting_throws').map(r => r.phase)).toEqual(['intent', 'applied'])
  })

  it('enrols only the dominant voice when the Ext bucket holds two people', async () => {
    // `Ext` is not a person: identifySpeaker returns it for EVERY voice below
    // threshold, so five unrecognised people share one label. Measured on
    // meeting_1786628481833_eagkaz: 115 Ext embeddings, median pairwise cosine
    // 0.170, 98% below the identifier's own 0.55 accept threshold.
    seed('meeting_two', ['Ext', 'MU', 'Ext', 'Ext', 'Ext'], {
      rawIndices: RAW, startTime: ONE_HOUR_AGO(),
    })
    // Positions 0,2,3,4 carry Ext -> raw 3, 8, 13, 21. Three are one voice; raw 13
    // is somebody else entirely.
    writeChunkEmbeddings('meeting_two', [
      { i: 3, axis: 'a' }, { i: 8, axis: 'a' }, { i: 21, axis: 'a' },
      { i: 13, axis: 'b' },
    ])
    await startServer()

    const res = await post('/api/meeting/meeting_two/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.status).toBe(200)
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([3, 8, 21])
    expect(res.json.enrolment).toEqual({
      enrolled: 3, attempted: 4, created: true, clusterSkipped: 1, skipped: null,
    })
  })

  it('enrols NOTHING when the bucket has no dominant voice at all', async () => {
    seed('meeting_crowd', ['Ext', 'MU', 'Ext', 'Ext', 'MU'], {
      rawIndices: RAW, startTime: ONE_HOUR_AGO(),
    })
    // Positions 0, 2, 3 -> raw 3, 8, 13. Three mutually orthogonal strangers.
    const dir = join(dataDir, 'chunk-embeddings')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meeting_crowd.jsonl'), [3, 8, 13].map((i, n) => {
      const v = new Float32Array(EMBEDDING_DIM)
      v[n * 50] = 100
      v[EMBEDDING_DIM - 1] = i
      return JSON.stringify({ i, speaker: 'Ext', similarity: 0.2, dim: v.length, v: encodeEmbedding(v) })
    }).join('\n') + '\n')
    await startServer()

    const res = await post('/api/meeting/meeting_crowd/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(enrolCalls).toEqual([])
    // clusterSkipped === attempted is the panel's cue: "0 enrolled, 3 chunks
    // looked like different voices." No profile is invented from a crowd.
    expect(res.json.enrolment).toEqual({
      enrolled: 0, attempted: 3, created: false, clusterSkipped: 3, skipped: null,
    })
  })

  it('APPENDS to an existing name and reports created: false', async () => {
    // No confirmation prompt — this is the same person being named again in a
    // second meeting, which is exactly how a profile is supposed to harden. But
    // claiming a profile was created when it already existed is a lie the panel
    // would repeat to the user.
    seed('meeting_append', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_append', ALL_ROWS)
    seedVoiceProfile('Kirstyn Blum')
    await startServer()

    const res = await post('/api/meeting/meeting_append/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.json.enrolment).toEqual({
      enrolled: 3, attempted: 3, created: false, clusterSkipped: 0, skipped: null,
    })
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([3, 8, 21])
  })

  it('never claims creation when nothing was actually written', async () => {
    seed('meeting_nowrite', EXT_MU, { rawIndices: RAW, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_nowrite', ALL_ROWS)
    await startServer()
    enrolThrowsOnCall = 1                        // refuses on the very first sample

    const res = await post('/api/meeting/meeting_nowrite/relabel',
      { from: 'Ext', to: 'Ghost Person', confirm: true })
    expect(res.json.enrolment.enrolled).toBe(0)
    expect(res.json.enrolment.created).toBe(false)
  })

  it('bounds a large correction to 20 writes', async () => {
    // 109 chunks against a live 7.9 MB store is ~41 ms per enrollEmbedding cycle
    // — loadProfileStore, persistProfile, invalidateProfileCache, then the next
    // iteration re-reads the whole file. That blocks the event loop past COS
    // Control's 30 s helper timeout, so the user is told "Server stopped" for a
    // correction that actually applied.
    const labels = Array.from({ length: 40 }, () => 'Ext')
    const rawIndices = labels.map((_, i) => i * 3)          // gapped throughout
    seed('meeting_big', labels, { rawIndices, startTime: ONE_HOUR_AGO() })
    writeChunkEmbeddings('meeting_big', rawIndices.map(i => ({ i })))
    await startServer()

    const res = await post('/api/meeting/meeting_big/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.json.enrolment.attempted).toBe(40)
    expect(res.json.enrolment.enrolled).toBe(20)
    expect(enrolCalls).toHaveLength(20)
    // Still raw indices, at scale: every marker is a multiple of 3, and none is
    // a bare sidecar position that is not also a raw index.
    expect(enrolCalls.every(c => c.marker % 3 === 0)).toBe(true)
    expect(new Set(enrolCalls.map(c => c.marker)).size).toBe(20)
  })

  it('enrols a NEW name from a wrong existing label — the Milo case', async () => {
    // Live 2026-08-20: Nick Gurney → Milo LeBaron. The identifier had weakly
    // matched 19 chunks to an enrolled profile. Relabel named the meeting and
    // created no profile, because enrolment gated on placeholder `from`. Those
    // chunks ARE the new person. Mutating that `from` placeholder-only guard
    // back in fails this test.
    seed('meeting_milo', ['Nick Gurney', 'MU', 'Nick Gurney', 'MU', 'Nick Gurney'], {
      rawIndices: RAW, startTime: ONE_HOUR_AGO(),
    })
    writeChunkEmbeddings('meeting_milo', [
      { i: 3, speaker: 'Nick Gurney' }, { i: 8, speaker: 'Nick Gurney' }, { i: 21, speaker: 'Nick Gurney' },
      { i: 0, speaker: 'Vikas' }, { i: 2, speaker: 'MU' }, { i: 5, speaker: 'MU' },
    ])
    await startServer()

    const res = await post('/api/meeting/meeting_milo/relabel',
      { from: 'Nick Gurney', to: 'Milo LeBaron', confirm: true })
    expect(res.status).toBe(200)
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([3, 8, 21])
    expect(enrolCalls.map(c => c.marker)).not.toContain(2)
    expect(enrolCalls.every(c => c.name === 'Milo LeBaron')).toBe(true)
    expect(res.json.enrolment).toEqual({
      enrolled: 3, attempted: 3, created: true, clusterSkipped: 0, skipped: null,
    })
    expect(sidecarNow().labels).toEqual(['Milo LeBaron', 'MU', 'Milo LeBaron', 'MU', 'Milo LeBaron'])
  })

  it('appends onto an existing name from a wrong existing label', async () => {
    // Second cluster in the same meeting: Richard Jenkins → Milo, after Milo
    // already exists. Additional training, not a global merge.
    seed('meeting_second', ['Richard Jenkins', 'MU', 'Richard Jenkins', 'MU', 'Richard Jenkins'], {
      rawIndices: RAW, startTime: ONE_HOUR_AGO(),
    })
    writeChunkEmbeddings('meeting_second', [
      { i: 3, speaker: 'Richard Jenkins' }, { i: 8, speaker: 'Richard Jenkins' },
      { i: 21, speaker: 'Richard Jenkins' }, { i: 2, speaker: 'MU' },
    ])
    seedVoiceProfile('Milo LeBaron')
    await startServer()

    const res = await post('/api/meeting/meeting_second/relabel',
      { from: 'Richard Jenkins', to: 'Milo LeBaron', confirm: true })
    expect(res.json.enrolment).toEqual({
      enrolled: 3, attempted: 3, created: false, clusterSkipped: 0, skipped: null,
    })
    expect(enrolCalls.map(c => c.marker).sort((a, b) => a - b)).toEqual([3, 8, 21])
  })
}, HTTP_TEST_TIMEOUT)

describe('chained corrections', () => {
  it('lets a second correction refine the first', async () => {
    // Ext to a rough name to the right name — the realistic sequence when a
    // human recognises a voice but not the exact spelling.
    seed('meeting_ch1', ['Ext', 'MU'], { scribe: SCRIBE.replace(/Luke H/g, 'Ext') })
    await startServer()

    expect((await post('/api/meeting/meeting_ch1/relabel', { from: 'Ext', to: 'Luke H', confirm: true })).status).toBe(200)
    expect((await post('/api/meeting/meeting_ch1/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })).status).toBe(200)

    expect(sidecarNow().labels).toEqual(['Luke Henry', 'MU'])
    const { currentLabelFor } = await import('../lib/meeting-corrections.js')
    expect(currentLabelFor('meeting_ch1', 'Ext')).toBe('Luke Henry')
  })

  it('merges a split identity without leaving a duplicate attendee', async () => {
    // The live failure this whole feature exists for: Luke H and Luke Henry are
    // one person split across two profiles.
    seed('meeting_ch2', ['Luke H', 'Luke Henry', 'MU'], {
      scribe: SCRIBE.replace('- Luke H\n', '- Luke H\n- Luke Henry\n'),
    })
    await startServer()

    const res = await post('/api/meeting/meeting_ch2/relabel', { from: 'Luke H', to: 'Luke Henry', confirm: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().speakers).toEqual(['Luke Henry', 'MU'])
    const attendees = scribeNow().split('## Summary')[0]
    expect(attendees.match(/^- Luke Henry$/gm)).toHaveLength(1)
  })
}, HTTP_TEST_TIMEOUT)

describe('backfilling enrolment from a recorded correction', () => {
  // The retroactive path. A voice named BEFORE enrolment shipped has a correct
  // transcript and no profile, and re-running the rename cannot help — she is already
  // a real name, so the placeholder guard declines. Kirstyn Blum is the live case:
  // 60 + 109 chunks across two meetings, absent from a 77-profile store.
  //
  // It must run IN-PROCESS: the voice store is owned by the running server and
  // rewritten wholesale, so an external enrol is silently clobbered. An attempt on
  // 2026-08-13 validated cleanly, selected 20 samples, and left the store at its
  // Aug 7 mtime.

  it('previews without writing, then enrols only on confirm', async () => {
    seed('meeting_bf1', ['Ext', 'MU', 'Ext'])
    await startServer()
    await post('/api/meeting/meeting_bf1/relabel', { from: 'Ext', to: 'Rae Lin', confirm: true })
    enrolCalls.length = 0

    const preview = await post('/api/meeting/meeting_bf1/backfill-enrolment', { speaker: 'Rae Lin' })
    expect(preview.status).toBe(200)
    expect(preview.json.confirmed).toBe(false)
    expect(enrolCalls).toEqual([])

    const applied = await post('/api/meeting/meeting_bf1/backfill-enrolment',
      { speaker: 'Rae Lin', confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.json.confirmed).toBe(true)
  })

  it('backfills a named-source new-name correction — the Milo hole', async () => {
    // Today's live ledger: Nick Gurney → Milo LeBaron already applied, no
    // profile. Re-running the rename cannot help (Milo is already the label),
    // and the old placeholder `from` guard made backfill skip too.
    seed('meeting_bf2', ['Nick Gurney', 'MU', 'Nick Gurney', 'MU', 'Nick Gurney'], {
      rawIndices: [3, 5, 8, 13, 21], startTime: Date.now() - 3_600_000,
    })
    writeChunkEmbeddings('meeting_bf2', [
      { i: 3, speaker: 'Nick Gurney' }, { i: 8, speaker: 'Nick Gurney' }, { i: 21, speaker: 'Nick Gurney' },
    ])
    await startServer()
    await post('/api/meeting/meeting_bf2/relabel',
      { from: 'Nick Gurney', to: 'Milo LeBaron', confirm: true })
    enrolCalls.length = 0

    const preview = await post('/api/meeting/meeting_bf2/backfill-enrolment',
      { speaker: 'Milo LeBaron' })
    expect(preview.status).toBe(200)
    expect(preview.json.confirmed).toBe(false)
    expect(preview.json.totals.eligible).toBe(1)
    expect(preview.json.totals.skippedNamedSource).toBe(0)
    expect(enrolCalls).toEqual([])

    const applied = await post('/api/meeting/meeting_bf2/backfill-enrolment',
      { speaker: 'Milo LeBaron', confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.json.totals.enrolled).toBeGreaterThan(0)
    expect(enrolCalls.every(c => c.name === 'Milo LeBaron')).toBe(true)
  })

  it('404s for a speaker with no applied correction here', async () => {
    seed('meeting_bf3', ['Ext', 'MU'])
    await startServer()
    const res = await post('/api/meeting/meeting_bf3/backfill-enrolment', { speaker: 'Nobody At All' })
    expect(res.status).toBe(404)
    expect(res.json.reason).toBe('no_correction')
  })

  it('requires a speaker', async () => {
    seed('meeting_bf4', ['Ext', 'MU'])
    await startServer()
    const res = await post('/api/meeting/meeting_bf4/backfill-enrolment', {})
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('invalid_label')
  })
}, HTTP_TEST_TIMEOUT)
