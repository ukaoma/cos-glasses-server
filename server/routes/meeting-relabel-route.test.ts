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

function seed(sessionId: string, labels: string[], opts: { scribe?: string } = {}): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), opts.scribe ?? SCRIBE)
  writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify({
    schemaVersion: 2,
    sessionId,
    startTime: 1786027607017,
    durationMs: 807222,
    speakers: [...new Set(labels)],
    chunks: labels.map((speaker, i) => ({
      text: `segment ${i} about the Jewel360 pipeline at thirty six percent`,
      speaker, elapsed: i * 7000, similarity: 0.82,
      words: [{ word: ' segment', start: 0, end: 0.4, probability: 0.9 }],
    })),
  }, null, 2))
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

const enrolCalls: Array<{ name: string; source: string }> = []
const embeddingIndexRequests: Array<{ sessionId: string; indices: number[] }> = []

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU',
    getVocabulary: () => [],
    getOwnerName: () => 'Miles',
    getTranscriptionProfileStatus: () => ({}),
  }))
  // Naming a placeholder is a FIRST TRAINING RUN, so the route must reach the voice
  // store. Real embeddings need ONNX, which the suite does not have — these seams
  // record the calls so enrolment is observable without it.
  enrolCalls.length = 0
  embeddingIndexRequests.length = 0
  vi.doMock('../lib/chunk-embedding-store.js', () => ({
    chunkEmbeddingsForIndices: (sessionId: string, indices: number[]) => {
      embeddingIndexRequests.push({ sessionId, indices: [...indices] })
      return indices.map(i => ({ index: i, embedding: new Float32Array([i, 1, 2]) }))
    },
  }))
  vi.doMock('../lib/speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/speaker-embeddings.js')
    return {
      ...actual,
      enrollEmbedding: (name: string, _e: Float32Array, source: string) => {
        enrolCalls.push({ name, source })
        return { success: true, dim: 3 }
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
  vi.doUnmock('../lib/chunk-embedding-store.js')
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

  // Naming a placeholder is a FIRST TRAINING RUN for a new person, not a text edit.
  //
  // Before this, relabel was text-only: it rewrote the sidecar and never touched the
  // voice store. Saving "Kirstyn Blum" over 109 segments labelled that one meeting
  // and taught the system nothing — she never appeared in /api/voice/profiles, the
  // review panel still offered her as `new name` inside the SAME meeting, and no
  // later meeting could match her. Every one of the 24 tests here passed throughout.
  it('does NOT enrol while enrolment is disabled (6.27.11 safety revert)', async () => {
    seed('meeting_enrol', ['Ext', 'MU', 'Ext'], {
      scribe: SCRIBE.replace(/Luke H/g, 'Ext'),
    })
    await startServer()

    const res = await post('/api/meeting/meeting_enrol/relabel',
      { from: 'Ext', to: 'Kirstyn Blum', confirm: true })
    expect(res.status).toBe(200)
    // DISABLED in 6.27.11. 6.27.10 enrolled here and was WRONG: it joined compacted
    // sidecar positions against raw capture indices, so on a live session 73 of 103
    // rows belonged to other people, 22 of them the owner. This assertion is
    // deliberately inverted rather than deleted, so re-enabling without the
    // attachRawChunkIndices mapping fails loudly instead of silently poisoning.
    //
    // NOTE the old assertion `indices: [0, 2]` passed only because this 3-chunk seed
    // has no gaps, so position happened to equal raw index. It pinned the bug as the
    // contract. Any re-enable needs a GAPPED fixture.
    expect(res.json.enrolledEmbeddings).toBe(0)
    expect(enrolCalls).toEqual([])
  })

  it('does NOT enrol when correcting one real name to another', async () => {
    // Moving a voice between existing people is merge-profiles: explicit and
    // confirmation-gated. Doing it implicitly here would poison profiles — a sweep of
    // this store found two distinct people at 0.85 similarity.
    seed('meeting_noenrol', ['Luke Henry', 'MU', 'Luke Henry'])
    await startServer()

    const res = await post('/api/meeting/meeting_noenrol/relabel',
      { from: 'Luke Henry', to: 'Chris Krubeck', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.enrolledEmbeddings).toBe(0)
    expect(enrolCalls).toEqual([])
  })

  it('does not enrol a placeholder onto a placeholder', async () => {
    seed('meeting_pp', ['Ext', 'MU', 'Ext'])
    await startServer()
    const res = await post('/api/meeting/meeting_pp/relabel',
      { from: 'Ext', to: 'Unidentified 2', confirm: true })
    expect(res.status).toBe(200)
    expect(enrolCalls).toEqual([])
  })

  // KNOWN VACUOUS: both mocks are pure and cannot throw, so the catch block has no
  // coverage. Kept as a rename-still-works check; re-enabling enrolment needs a mock
  // that actually throws.
  it('completes the rename (catch path NOT covered — see comment)', async () => {
    // Enrolment is a bonus on top of the relabel. A refusing voice store must not
    // undo the rename the user actually asked for.
    seed('meeting_throws', ['Ext', 'MU', 'Ext'])
    await startServer()
    const res = await post('/api/meeting/meeting_throws/relabel',
      { from: 'Ext', to: 'New Person', confirm: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels).toEqual(['New Person', 'MU', 'New Person'])
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
